/**
 * Everything about one span, shaped by what it is: a model call reads as a conversation and a
 * response; a retrieval as ranked documents; an evaluator as its verdict and evidence. Raw
 * input, output and attributes are always one tab away.
 */
import type { Evaluation, JsonValue, Span, TraceDetail } from '@scope-ai/protocol';
import { Tabs } from 'radix-ui';
import { type ReactNode, useState } from 'react';
import { useSpan } from '../../api/queries.ts';
import {
  formatCost,
  formatDateTime,
  formatDuration,
  formatNumber,
  formatScore,
} from '../../lib/format.ts';
import {
  chatMessages,
  isObject,
  requestParams,
  responseText,
  retrievedDocuments,
} from '../../lib/payload.ts';
import { CodeBlock } from '../../ui/CodeBlock.tsx';
import { IdChip } from '../../ui/Copy.tsx';
import { cx } from '../../ui/cx.ts';
import { Alert } from '../../ui/icons.tsx';
import { SpanKindTag } from '../../ui/Kind.tsx';
import { Facts } from '../../ui/Panel.tsx';
import { OutcomeBadge } from '../../ui/Status.tsx';
import { EvaluationCard } from './Evaluations.tsx';

interface TabDef {
  id: string;
  label: string;
  content: ReactNode;
}

function DetailTabs({ tabs }: { tabs: TabDef[] }) {
  const [value, setValue] = useState(tabs[0]?.id ?? '');
  const active = tabs.some((t) => t.id === value) ? value : (tabs[0]?.id ?? '');
  return (
    <Tabs.Root value={active} onValueChange={setValue} className="flex min-h-0 flex-col">
      <Tabs.List
        aria-label="Span details"
        className="flex gap-1 overflow-x-auto border-b border-line px-3"
      >
        {tabs.map((t) => (
          <Tabs.Trigger
            key={t.id}
            value={t.id}
            className={cx(
              '-mb-px h-9 border-b-2 px-2 text-xs font-medium whitespace-nowrap',
              'border-transparent text-fg-3 hover:text-fg data-[state=active]:border-accent data-[state=active]:text-fg',
            )}
          >
            {t.label}
          </Tabs.Trigger>
        ))}
      </Tabs.List>
      {tabs.map((t) => (
        <Tabs.Content key={t.id} value={t.id} className="space-y-3 p-4 outline-none">
          {t.content}
        </Tabs.Content>
      ))}
    </Tabs.Root>
  );
}

function Conversation({ input }: { input: JsonValue | null }) {
  const messages = chatMessages(input);
  if (!messages) return <CodeBlock label="Input" value={input} />;
  return (
    <div className="space-y-3">
      {messages.map((m, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: messages are positional
        <CodeBlock key={i} label={m.role} text={m.content} />
      ))}
    </div>
  );
}

function modelFacts(span: Span): Array<[ReactNode, ReactNode]> {
  const a = span.attributes;
  const facts: Array<[ReactNode, ReactNode]> = [
    [
      'Model',
      <code key="m" className="text-xs">
        {span.provider ? `${span.provider}:` : ''}
        {span.model}
      </code>,
    ],
  ];
  const served = a['gen_ai.response.model'];
  if (typeof served === 'string' && served !== span.model) facts.push(['Served by', served]);
  const estimated = a['scope.usage.estimated'] === true;
  facts.push([
    'Tokens',
    `${formatNumber(span.inputTokens)} in · ${formatNumber(span.outputTokens)} out${estimated ? ' (estimated locally)' : ''}`,
  ]);
  const cacheRead = a['gen_ai.usage.cache_read_input_tokens'];
  if (typeof cacheRead === 'number') facts.push(['Cache reads', formatNumber(cacheRead)]);
  facts.push([
    'Estimated cost',
    span.provider === 'local'
      ? '$0.00 (offline stand-in model)'
      : span.costUsd === null
        ? 'unknown — no price for this model; add one under pricing in scope.yaml'
        : formatCost(span.costUsd),
  ]);
  const reasons = a['gen_ai.response.finish_reasons'];
  if (Array.isArray(reasons)) facts.push(['Finish reason', reasons.join(', ')]);
  const ignored = a['scope.request.ignored_params'];
  if (Array.isArray(ignored) && ignored.length)
    facts.push(['Not sent', `${ignored.join(', ')} (not supported by this model)`]);
  return facts;
}

function Documents({ output }: { output: JsonValue | null }) {
  const docs = retrievedDocuments(output);
  if (!docs) return <CodeBlock label="Output" value={output} />;
  if (docs.length === 0)
    return <p className="text-sm text-fg-2">No documents matched the query.</p>;
  return (
    <ol className="space-y-3">
      {docs.map((d, i) => (
        <li key={d.id} className="rounded-md border border-line">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-3 py-2 text-xs">
            <span className="tabular font-medium text-fg-3">#{i + 1}</span>
            <span className="font-medium text-fg">{d.title ?? d.id}</span>
            {d.source && <code className="text-fg-3">{d.source}</code>}
            {d.score !== null && (
              <span className="tabular ml-auto text-fg-2">score {d.score.toFixed(3)}</span>
            )}
          </div>
          <p className="px-3 py-2 text-sm whitespace-pre-wrap text-fg">{d.text}</p>
        </li>
      ))}
    </ol>
  );
}

function RawTabs(span: Span): TabDef[] {
  const tabs: TabDef[] = [];
  if (Object.keys(span.attributes).length)
    tabs.push({
      id: 'attributes',
      label: 'Attributes',
      content: <CodeBlock label="Attributes" value={span.attributes} collapse={false} />,
    });
  if (span.events.length)
    tabs.push({
      id: 'events',
      label: `Events (${span.events.length})`,
      content: (
        <ul className="space-y-2">
          {span.events.map((e, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: events are positional
            <li key={i} className="rounded-md border border-line px-3 py-2 text-sm">
              <div className="flex items-center gap-2">
                <span className="font-medium text-fg">{e.name}</span>
                <span className="tabular ml-auto text-xs text-fg-3">
                  +{formatDuration(e.offsetMs)}
                </span>
              </div>
              {Object.keys(e.attributes).length > 0 && (
                <pre className="mt-1 text-xs whitespace-pre-wrap text-fg-2">
                  {JSON.stringify(e.attributes, null, 2)}
                </pre>
              )}
            </li>
          ))}
        </ul>
      ),
    });
  return tabs;
}

/** Content capture was off when the span was stored: its input and output were never kept. */
function captureOff(span: Span): boolean {
  return span.attributes['scope.content.omitted'] === true;
}

interface SpanDetailProps {
  span: Span;
  trace: TraceDetail;
  evaluation: Evaluation | undefined;
}

/**
 * A span of a large trace may arrive without its input and output (the trace was loaded with a
 * content budget); they are fetched when the span is shown, and the panel says so meanwhile.
 */
export function SpanDetail(props: SpanDetailProps) {
  const { span, trace } = props;
  const full = useSpan(trace.trace.id, span.id, span.contentOmitted);
  if (!span.contentOmitted) return <SpanDetailBody {...props} />;
  if (full.data) return <SpanDetailBody {...props} span={full.data} />;
  return (
    <SpanDetailBody
      {...props}
      notice={
        full.isError ? (
          <p role="alert" className="flex items-center gap-1.5 text-xs text-bad-fg">
            <Alert size={12} /> This span's input and output could not be loaded:{' '}
            {full.error.message}
          </p>
        ) : (
          <p role="status" className="text-xs text-fg-3">
            Loading this span's input and output (left out of the trace download because the trace
            is large)…
          </p>
        )
      }
    />
  );
}

function SpanDetailBody({
  span,
  trace,
  evaluation,
  notice,
}: SpanDetailProps & { notice?: ReactNode }) {
  const isRoot = span.parentId === null && span.kind !== 'evaluation';
  const tabs: TabDef[] = [];

  if (isRoot) {
    const expected = trace.trace.metadata.expected;
    const { expected: _e, ...metadata } = trace.trace.metadata;
    tabs.push({
      id: 'io',
      label: 'Input & output',
      content: (
        <>
          <CodeBlock label="Input" value={trace.trace.input} />
          <CodeBlock label="Output" value={trace.trace.output} />
          {expected !== undefined && <CodeBlock label="Expected" value={expected} />}
        </>
      ),
    });
    if (Object.keys(metadata).length)
      tabs.push({
        id: 'metadata',
        label: 'Metadata',
        content: <CodeBlock label="Metadata" value={metadata} collapse={false} />,
      });
  } else if (span.kind === 'llm') {
    const text = responseText(span.output);
    const params = requestParams(span.input);
    tabs.push({
      id: 'call',
      label: 'Model call',
      content: (
        <>
          <Facts items={modelFacts(span)} />
          <h4 className="pt-2 text-xs font-medium text-fg-3">Prompt</h4>
          <Conversation input={span.input} />
          {text !== null ? (
            <CodeBlock label="Response" text={text} />
          ) : (
            <CodeBlock label="Output" value={span.output} />
          )}
          {params && <CodeBlock label="Request parameters" value={params} collapse={false} />}
        </>
      ),
    });
  } else if (span.kind === 'retrieval') {
    const input = isObject(span.input) ? span.input : {};
    const facts: Array<[ReactNode, ReactNode]> = [];
    if (typeof input.query === 'string') facts.push(['Query', input.query]);
    if (input.top_k !== undefined) facts.push(['Top k', String(input.top_k)]);
    if (typeof input.corpus === 'string')
      facts.push([
        'Corpus',
        <code key="c" className="text-xs">
          {input.corpus}
        </code>,
      ]);
    tabs.push({
      id: 'documents',
      label: 'Documents',
      content: (
        <>
          {facts.length > 0 && <Facts items={facts} />}
          <Documents output={span.output} />
        </>
      ),
    });
    tabs.push({
      id: 'input',
      label: 'Input',
      content: <CodeBlock label="Input" value={span.input} />,
    });
  } else if (span.kind === 'evaluation' && evaluation) {
    tabs.push({
      id: 'evaluation',
      label: 'Evaluation',
      content: <EvaluationCard evaluation={evaluation} />,
    });
  } else {
    tabs.push({
      id: 'io',
      label: 'Input & output',
      content: (
        <>
          {span.input !== null && <CodeBlock label="Input" value={span.input} />}
          {span.output !== null && <CodeBlock label="Output" value={span.output} />}
          {span.input === null && span.output === null && (
            <p className="text-sm text-fg-2">This span recorded no input or output.</p>
          )}
        </>
      ),
    });
  }
  tabs.push(...RawTabs(span));

  return (
    <div className="flex min-h-0 flex-col">
      <div className="space-y-2 border-b border-line px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <SpanKindTag kind={span.kind} />
          <h2 className="text-base font-semibold text-fg">{span.name}</h2>
          <OutcomeBadge outcome={span.status} />
          <span className="ml-auto">
            <IdChip id={span.id} length={16} />
          </span>
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-fg-2">
          <span>{formatDuration(span.durationMs)}</span>
          <span>starts at +{formatDuration(span.offsetMs)}</span>
          <span title={span.startTime}>{formatDateTime(span.startTime)}</span>
          {span.kind === 'evaluation' && evaluation && (
            <span>score {formatScore(evaluation.score)}</span>
          )}
        </div>
        {span.error && (
          <div role="alert" className="rounded-md bg-bad-wash px-3 py-2 text-sm text-bad-fg">
            <div className="font-medium">
              {span.error.type}
              {span.error.code ? ` (${span.error.code})` : ''}: {span.error.message}
            </div>
            {span.error.hint && <div className="mt-1 text-fg-2">{span.error.hint}</div>}
          </div>
        )}
        {notice}
        {captureOff(span) && (
          <p className="flex items-center gap-1.5 text-xs text-fg-3">
            <Alert size={12} /> Content capture is off for this project, so inputs and outputs were
            not stored.
          </p>
        )}
      </div>
      <DetailTabs key={span.id} tabs={tabs} />
    </div>
  );
}
