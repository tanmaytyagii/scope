import type { TraceSummary } from '@scope-ai/protocol';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { prefetchTrace } from '../api/queries.ts';
import { formatCost, formatDuration, formatTokens, relativeTime } from '../lib/format.ts';
import { readablePreview } from '../lib/payload.ts';
import { Bolt, Check, Cross, Skip } from '../ui/icons.tsx';
import { Pill } from '../ui/Status.tsx';
import { Table, TD, TH, THead, TR } from '../ui/Table.tsx';
import { Tooltip } from '../ui/Tooltip.tsx';

/**
 * One result per trace, combining execution and evaluation: an execution error outranks an
 * evaluator's verdict, and a trace nobody evaluated is just "completed".
 */
export function TraceResult({ trace }: { trace: Pick<TraceSummary, 'status' | 'evalStatus'> }) {
  if (trace.status === 'error')
    return (
      <Pill tone="bad" icon={<Bolt size={12} />}>
        error
      </Pill>
    );
  switch (trace.evalStatus) {
    case 'failed':
      return (
        <Pill tone="bad" icon={<Cross size={12} />}>
          eval failed
        </Pill>
      );
    case 'errored':
      return (
        <Pill tone="bad" icon={<Bolt size={12} />}>
          eval error
        </Pill>
      );
    case 'passed':
      return (
        <Pill tone="good" icon={<Check size={12} />}>
          passed
        </Pill>
      );
    default:
      return (
        <Pill
          tone="neutral"
          icon={<Skip size={12} />}
          title="Completed; no evaluations were recorded"
        >
          completed
        </Pill>
      );
  }
}

export function TraceTable({
  traces,
  showRun = true,
  showPreview = true,
}: {
  traces: TraceSummary[];
  showRun?: boolean;
  showPreview?: boolean;
}) {
  const client = useQueryClient();
  return (
    <Table>
      <THead>
        <TH>Trace</TH>
        <TH>Result</TH>
        {showPreview && <TH className="hidden xl:table-cell">Output</TH>}
        {showRun && <TH>Run</TH>}
        <TH align="right">Duration</TH>
        <TH align="right">Tokens</TH>
        <TH align="right">Cost</TH>
        <TH align="right">When</TH>
      </THead>
      <tbody>
        {traces.map((t) => (
          <TR key={t.id} to={`/traces/${t.id}`} onMouseEnter={() => prefetchTrace(client, t.id)}>
            <TD className="max-w-72">
              <Link
                to={`/traces/${t.id}`}
                className="block truncate font-medium text-fg hover:underline"
              >
                {t.caseId ?? t.name}
              </Link>
              <div className="truncate font-mono text-2xs text-fg-3">
                {t.caseId ? `${t.name} · ` : ''}
                {t.id.slice(0, 12)}
              </div>
            </TD>
            <TD>
              <TraceResult trace={t} />
            </TD>
            {showPreview && (
              <TD className="hidden max-w-md xl:table-cell">
                <span className="line-clamp-2 text-xs text-fg-2">
                  {t.error ? (
                    <span className="text-bad-fg">{t.error.message}</span>
                  ) : (
                    readablePreview(t.outputPreview) || '—'
                  )}
                </span>
              </TD>
            )}
            {showRun && (
              <TD>
                {t.run ? (
                  <Link
                    to={`/runs/${t.run.number}`}
                    className="tabular text-fg-2 hover:text-fg hover:underline"
                  >
                    #{t.run.number}
                  </Link>
                ) : (
                  <Tooltip content="Recorded by an application instrumented with the SDK, outside a run.">
                    <span className="cursor-help text-fg-3">SDK</span>
                  </Tooltip>
                )}
              </TD>
            )}
            <TD align="right">{formatDuration(t.durationMs)}</TD>
            <TD align="right">
              {t.usage.estimated ? (
                <Tooltip content="Estimated locally: the provider did not report token counts.">
                  <span className="cursor-help">~{formatTokens(t.usage.totalTokens)}</span>
                </Tooltip>
              ) : (
                formatTokens(t.usage.totalTokens)
              )}
            </TD>
            <TD align="right" className={t.costUsd === null ? 'text-fg-3' : undefined}>
              {t.llmCallCount === 0 ? '—' : formatCost(t.costUsd)}
            </TD>
            <TD align="right" className="text-fg-3" title={t.startTime}>
              {relativeTime(t.startTime)}
            </TD>
          </TR>
        ))}
      </tbody>
    </Table>
  );
}
