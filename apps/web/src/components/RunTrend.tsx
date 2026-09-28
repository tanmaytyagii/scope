/**
 * "Did quality hold up run over run, and which run broke a gate?" — pass rate per run as
 * columns. Emphasis form: runs whose gates failed or warned take the status color (with an icon
 * in the legend and the tooltip); every other run stays neutral.
 */
import type { GateStatus } from '@scope-ai/protocol';
import { Columns } from '../charts/Columns.tsx';
import { ChartFrame, DataTable, Legend, TooltipRow } from '../charts/Frame.tsx';
import { formatDateTime, formatPercent } from '../lib/format.ts';
import { Alert, Cross } from '../ui/icons.tsx';
import { RunResult } from '../ui/Status.tsx';

export interface TrendRun {
  id: string;
  number: number;
  workflow: string;
  variant: string | null;
  passRate: number | null;
  gateStatus: GateStatus;
  startedAt: string;
}

const COLOR: Record<GateStatus, string> = {
  failed: 'var(--bad)',
  warned: 'var(--warn)',
  passed: 'var(--neutral-mark)',
  none: 'var(--neutral-mark)',
};

const GATE_LABEL: Record<GateStatus, string> = {
  failed: 'gates failed',
  warned: 'passed with warnings',
  passed: 'gates passed',
  none: 'no gates',
};

export function RunTrend({
  runs,
  title = 'Pass rate by run',
  description,
  pending,
  showWorkflow = true,
}: {
  runs: TrendRun[];
  title?: string;
  description?: string;
  pending?: boolean;
  showWorkflow?: boolean;
}) {
  const hasFailed = runs.some((r) => r.gateStatus === 'failed');
  const hasWarned = runs.some((r) => r.gateStatus === 'warned');
  return (
    <ChartFrame
      title={title}
      description={
        description ??
        `Last ${runs.length} completed ${runs.length === 1 ? 'run' : 'runs'}, oldest first`
      }
      pending={pending}
      legend={
        <Legend
          items={[
            { label: 'gates passed or none', color: 'var(--neutral-mark)' },
            ...(hasFailed
              ? [
                  {
                    label: 'gates failed',
                    color: 'var(--bad)',
                    icon: <Cross size={12} className="text-bad-fg" />,
                  },
                ]
              : []),
            ...(hasWarned
              ? [
                  {
                    label: 'warnings',
                    color: 'var(--warn)',
                    icon: <Alert size={12} className="text-warn-fg" />,
                  },
                ]
              : []),
          ]}
        />
      }
      chart={
        <Columns
          ariaLabel={`${title}: ${runs.length} runs. Use the Table button for values.`}
          yMax={1}
          yFormat={(v) => `${Math.round(v * 100)}%`}
          data={runs.map((r) => ({
            key: r.id,
            label: `#${r.number}`,
            href: `/runs/${r.number}`,
            segments: [{ value: r.passRate ?? 0, color: COLOR[r.gateStatus] }],
            tooltip: (
              <>
                <div className="mb-1 text-fg-3">
                  Run #{r.number}
                  {showWorkflow ? ` · ${r.workflow}` : ''}
                  {r.variant ? ` · ${r.variant}` : ''}
                </div>
                <TooltipRow label="pass rate" value={formatPercent(r.passRate)} />
                <div className="mt-1 flex items-center gap-1 text-fg-2">
                  {r.gateStatus === 'failed' && <Cross size={12} className="text-bad-fg" />}
                  {r.gateStatus === 'warned' && <Alert size={12} className="text-warn-fg" />}
                  {GATE_LABEL[r.gateStatus]}
                </div>
                <div className="mt-1 text-fg-3">{formatDateTime(r.startedAt)}</div>
              </>
            ),
          }))}
        />
      }
      table={
        <DataTable
          columns={[
            { label: 'Run' },
            ...(showWorkflow ? [{ label: 'Workflow' }] : []),
            { label: 'Variant' },
            { label: 'Pass rate', align: 'right' as const },
            { label: 'Result' },
            { label: 'Started' },
          ]}
          rows={runs.map((r) => [
            `#${r.number}`,
            ...(showWorkflow ? [r.workflow] : []),
            r.variant ?? '—',
            formatPercent(r.passRate),
            <RunResult key="r" status="completed" gateStatus={r.gateStatus} />,
            formatDateTime(r.startedAt),
          ])}
        />
      }
    />
  );
}
