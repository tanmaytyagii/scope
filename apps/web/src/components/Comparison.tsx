/**
 * The pieces of a comparison between two sides — two runs, or a run and its baseline: metric
 * deltas with direction-aware verdicts, and the cases whose outcome or scores changed.
 */
import type { CaseChange, ConfigDiff, JsonValue, MetricDelta } from '@scope-ai/protocol';
import { Link } from 'react-router';
import { formatDelta, formatDuration, formatMetric, formatScore } from '../lib/format.ts';
import { ArrowDown, ArrowRight, ArrowUp } from '../ui/icons.tsx';
import { OutcomeBadge, Pill, type Tone } from '../ui/Status.tsx';
import { Table, TD, TH, THead, TR } from '../ui/Table.tsx';

export function Verdict({ change }: { change: MetricDelta['change'] }) {
  if (change === 'improved')
    return (
      <Pill tone="good" icon={<ArrowUp size={12} />}>
        better
      </Pill>
    );
  if (change === 'regressed')
    return (
      <Pill tone="bad" icon={<ArrowDown size={12} />}>
        worse
      </Pill>
    );
  if (change === 'unchanged') return <span className="text-xs text-fg-3">no change</span>;
  return <span className="text-xs text-fg-3">—</span>;
}

/** The headline metrics (or all of them), base next to head. */
export function MetricDeltaTable({
  metrics,
  headline,
  showAll,
  baseLabel,
  headLabel,
}: {
  metrics: MetricDelta[];
  headline: string[];
  showAll: boolean;
  baseLabel: string;
  headLabel: string;
}) {
  const byId = new Map(metrics.map((m) => [m.id, m]));
  const shown = showAll
    ? metrics
    : headline.map((id) => byId.get(id)).filter((m): m is MetricDelta => Boolean(m));
  return (
    <Table>
      <THead>
        <TH>Metric</TH>
        <TH align="right">{baseLabel}</TH>
        <TH align="right">{headLabel}</TH>
        <TH align="right">Change</TH>
        <TH>Verdict</TH>
      </THead>
      <tbody>
        {shown.map((m) => (
          <TR key={m.id}>
            <TD>
              <div className="text-fg">{m.label}</div>
              <div className="font-mono text-2xs text-fg-3">{m.id}</div>
            </TD>
            <TD align="right">{formatMetric(m.base, m.unit)}</TD>
            <TD align="right">{formatMetric(m.head, m.unit)}</TD>
            <TD align="right" className="text-fg-2">
              {formatDelta(m.base, m.head, m.unit)}
            </TD>
            <TD>
              <Verdict change={m.change} />
            </TD>
          </TR>
        ))}
      </tbody>
    </Table>
  );
}

export type ChangeCounts = Record<CaseChange['kind'], number>;

/** How many cases changed, by kind. `onlyHead` / `onlyBase` name the sides of added/removed. */
export function CaseChangeCounts({
  counts,
  onlyHead,
  onlyBase,
}: {
  counts: ChangeCounts;
  onlyHead: string;
  onlyBase: string;
}) {
  return (
    <div className="flex flex-wrap gap-2 border-b border-line px-4 py-2.5">
      <Pill tone={counts.regressed ? 'bad' : 'neutral'}>{counts.regressed} regressed</Pill>
      <Pill tone={counts.fixed ? 'good' : 'neutral'}>{counts.fixed} fixed</Pill>
      <Pill tone={counts.changed ? 'info' : 'neutral'}>{counts.changed} score changes</Pill>
      {counts.added > 0 && (
        <Pill>
          {counts.added} {onlyHead}
        </Pill>
      )}
      {counts.removed > 0 && (
        <Pill>
          {counts.removed} {onlyBase}
        </Pill>
      )}
      <Pill>{counts.unchanged} unchanged</Pill>
    </div>
  );
}

const KIND_TONE: Record<CaseChange['kind'], Tone> = {
  regressed: 'bad',
  fixed: 'good',
  changed: 'info',
  added: 'neutral',
  removed: 'neutral',
  unchanged: 'neutral',
};

function describeEvaluators(change: CaseChange): string[] {
  return change.evaluators
    .filter((e) => e.change === 'improved' || e.change === 'regressed' || !e.base || !e.head)
    .map((e) => {
      const from = e.base
        ? `${e.base.status}${e.base.score !== null ? ` ${formatScore(e.base.score)}` : ''}`
        : 'absent';
      const to = e.head
        ? `${e.head.status}${e.head.score !== null ? ` ${formatScore(e.head.score)}` : ''}`
        : 'absent';
      return `${e.evaluator}: ${from} → ${to}`;
    });
}

/**
 * One row per case change: outcome before and after, the evaluators that moved, and links to
 * the traces. `baseTraces` is false when the base side's traces are not in this database.
 */
export function CaseChangeTable({
  cases,
  baseTraces = true,
}: {
  cases: CaseChange[];
  baseTraces?: boolean;
}) {
  return (
    <Table>
      <THead>
        <TH>Case</TH>
        <TH>Change</TH>
        <TH>Outcome</TH>
        <TH>Evaluators</TH>
        <TH align="right">Duration</TH>
        <TH>Traces</TH>
      </THead>
      <tbody>
        {cases.map((change) => (
          <TR
            key={change.caseId}
            to={change.head?.traceId ? `/traces/${change.head.traceId}` : undefined}
          >
            <TD className="font-medium text-fg">{change.caseId}</TD>
            <TD>
              <Pill tone={KIND_TONE[change.kind]}>{change.kind}</Pill>
            </TD>
            <TD>
              <span className="inline-flex items-center gap-1.5">
                {change.base ? (
                  <OutcomeBadge outcome={change.base.outcome} />
                ) : (
                  <span className="text-fg-3">—</span>
                )}
                <ArrowRight size={12} className="text-fg-3" />
                {change.head ? (
                  <OutcomeBadge outcome={change.head.outcome} />
                ) : (
                  <span className="text-fg-3">—</span>
                )}
              </span>
            </TD>
            <TD className="max-w-md">
              <ul className="space-y-0.5 font-mono text-2xs text-fg-2">
                {describeEvaluators(change).map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </TD>
            <TD align="right" className="text-fg-2">
              {formatDuration(change.base?.durationMs)} → {formatDuration(change.head?.durationMs)}
            </TD>
            <TD>
              <span className="flex gap-3 text-xs">
                {baseTraces && change.base?.traceId && (
                  <Link
                    to={`/traces/${change.base.traceId}`}
                    className="text-accent-fg hover:underline"
                  >
                    base
                  </Link>
                )}
                {change.head?.traceId && (
                  <Link
                    to={`/traces/${change.head.traceId}`}
                    className="text-accent-fg hover:underline"
                  >
                    head
                  </Link>
                )}
              </span>
            </TD>
          </TR>
        ))}
      </tbody>
    </Table>
  );
}

function showValue(value: JsonValue | null): string {
  if (value === null) return 'not set';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > 60 ? `${text.slice(0, 59)}…` : text;
}

/** "sentences 2 → 1", "the workflow file", "the dataset": what changed, in short phrases. */
export function describeConfig(config: ConfigDiff | null | undefined): string[] {
  if (!config) return [];
  return [
    ...config.params.map((p) => `${p.key} ${showValue(p.base)} → ${showValue(p.head)}`),
    ...(config.workflowChanged ? ['the workflow file'] : []),
    ...(config.datasetChanged ? ['the dataset'] : []),
  ];
}

/** The configuration two runs differ in: parameters side by side, and workflow and dataset. */
export function ConfigChanges({
  config,
  baseLabel,
  headLabel,
}: {
  config: ConfigDiff;
  baseLabel: string;
  headLabel: string;
}) {
  const same = (flag: boolean | null, what: string) =>
    flag === null ? `${what}: not recorded` : flag ? `${what} changed` : `same ${what}`;
  return (
    <div>
      {config.params.length > 0 ? (
        <Table>
          <THead>
            <TH>Parameter</TH>
            <TH align="right">{baseLabel}</TH>
            <TH align="right">{headLabel}</TH>
          </THead>
          <tbody>
            {config.params.map((p) => (
              <TR key={p.key}>
                <TD className="font-mono text-xs text-fg">{p.key}</TD>
                <TD align="right" className="font-mono text-xs">
                  {showValue(p.base)}
                </TD>
                <TD align="right" className="font-mono text-xs">
                  {showValue(p.head)}
                </TD>
              </TR>
            ))}
          </tbody>
        </Table>
      ) : (
        <p className="px-4 pt-3 text-sm text-fg-2">
          {config.paramsKnown
            ? 'The same parameters.'
            : 'Parameters are not recorded for the base (saved before SCOPE 0.3).'}
        </p>
      )}
      <div className="flex flex-wrap gap-2 px-4 py-2.5">
        <Pill tone={config.workflowChanged ? 'info' : 'neutral'}>
          {same(config.workflowChanged, 'workflow file')}
        </Pill>
        <Pill tone={config.datasetChanged ? 'info' : 'neutral'}>
          {same(config.datasetChanged, 'dataset')}
        </Pill>
      </div>
    </div>
  );
}
