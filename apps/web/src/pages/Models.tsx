/**
 * Models — "which model is slowest, most used, most expensive, and how reliable?" In-cell bars
 * compare models within each column; the table itself is the data.
 */
import type { ModelUsage, TimeWindowName } from '@scope-ai/protocol';
import { Link } from 'react-router';
import { useModels } from '../api/queries.ts';
import { useTitle, useUrlState } from '../app/hooks.ts';
import {
  formatDuration,
  formatNumber,
  formatPercent,
  formatPrice,
  formatTokens,
  formatUsd,
  relativeTime,
} from '../lib/format.ts';
import { Segmented } from '../ui/Controls.tsx';
import { CellBar, PageHeader } from '../ui/Figures.tsx';
import { Panel } from '../ui/Panel.tsx';
import { EmptyState, ErrorState, Loading } from '../ui/States.tsx';
import { Pill } from '../ui/Status.tsx';
import { Table, TD, TH, THead, TR } from '../ui/Table.tsx';
import { Tooltip } from '../ui/Tooltip.tsx';

const WINDOWS: TimeWindowName[] = ['24h', '7d', '30d', '90d'];

function Cost({ m }: { m: ModelUsage }) {
  if (m.local) return <span className="text-fg-3">$0.00</span>;
  if (!m.price)
    return (
      <Tooltip content="No price is known for this model. Add it under pricing: in scope.yaml to estimate cost.">
        <span className="cursor-help text-fg-3">unknown</span>
      </Tooltip>
    );
  return (
    <>
      {formatUsd(m.costUsd)}
      {m.unpricedCalls > 0 && <span className="text-fg-3">+</span>}
    </>
  );
}

function ModelTable({
  items,
  title,
  description,
}: {
  items: ModelUsage[];
  title: string;
  description: string;
}) {
  const maxCalls = Math.max(...items.map((m) => m.calls), 0);
  const maxP95 = Math.max(...items.map((m) => m.p95Ms ?? 0), 0);
  const maxCost = Math.max(...items.map((m) => m.costUsd), 0);
  return (
    <Panel title={title} description={description}>
      <Table>
        <THead>
          <TH>Model</TH>
          <TH align="right">Calls</TH>
          <TH align="right">Errors</TH>
          <TH align="right">Tokens in / out</TH>
          <TH align="right">p50</TH>
          <TH align="right">p95</TH>
          <TH align="right">Estimated cost</TH>
          <TH>Price per 1M tokens</TH>
          <TH align="right">Last used</TH>
        </THead>
        <tbody>
          {items.map((m) => {
            const id = m.provider ? `${m.provider}:${m.model}` : m.model;
            return (
              <TR key={`${id}:${m.usage}`}>
                <TD>
                  <span className="flex items-center gap-2">
                    <Link
                      to={`/traces?model=${encodeURIComponent(id)}`}
                      className="font-mono text-xs text-fg hover:underline"
                    >
                      {id}
                    </Link>
                    {m.local && (
                      <Tooltip content="A deterministic offline stand-in for demos and tests — not a language model.">
                        <span className="cursor-help">
                          <Pill>offline stand-in</Pill>
                        </span>
                      </Tooltip>
                    )}
                  </span>
                </TD>
                <TD align="right">
                  <CellBar value={m.calls} max={maxCalls}>
                    {formatNumber(m.calls)}
                  </CellBar>
                </TD>
                <TD align="right" className={m.errors ? 'text-bad-fg' : 'text-fg-3'}>
                  {m.errors
                    ? `${formatNumber(m.errors)} (${formatPercent(m.errors / m.calls)})`
                    : '0'}
                </TD>
                <TD align="right">
                  {formatTokens(m.inputTokens)} <span className="text-fg-3">/</span>{' '}
                  {formatTokens(m.outputTokens)}
                </TD>
                <TD align="right">{formatDuration(m.p50Ms)}</TD>
                <TD align="right">
                  <CellBar value={m.p95Ms ?? 0} max={maxP95}>
                    {formatDuration(m.p95Ms)}
                  </CellBar>
                </TD>
                <TD align="right">
                  {m.price && maxCost > 0 ? (
                    <CellBar value={m.costUsd} max={maxCost}>
                      <Cost m={m} />
                    </CellBar>
                  ) : (
                    <Cost m={m} />
                  )}
                </TD>
                <TD className="text-xs text-fg-2">
                  {m.price ? (
                    <Tooltip
                      content={`${m.price.origin === 'project' ? 'From scope.yaml' : 'Built-in table'} · ${m.price.source}`}
                    >
                      <span className="cursor-help">
                        {formatPrice(m.price.input)} in · {formatPrice(m.price.output)} out
                        <span className="text-fg-3"> · {m.price.asOf}</span>
                      </span>
                    </Tooltip>
                  ) : (
                    <span className="text-fg-3">—</span>
                  )}
                </TD>
                <TD align="right" className="text-fg-3">
                  {relativeTime(m.lastUsedAt)}
                </TD>
              </TR>
            );
          })}
        </tbody>
      </Table>
    </Panel>
  );
}

export function Models() {
  useTitle('Models');
  const [state, setState] = useUrlState(['window'] as const);
  const window = (
    WINDOWS.includes(state.window as TimeWindowName) ? state.window : '7d'
  ) as TimeWindowName;
  const models = useModels(window);
  const header = (
    <PageHeader
      title="Models"
      meta="Costs are estimates from the pricing table (see Settings); unknown prices are shown as unknown, never $0."
      actions={
        <Segmented
          label="Time window"
          value={window}
          onChange={(w) => setState({ window: w === '7d' ? null : w })}
          options={WINDOWS.map((w) => ({ value: w, label: w }))}
        />
      }
    />
  );
  if (models.isPending)
    return (
      <>
        {header}
        <Loading rows={5} />
      </>
    );
  if (models.isError)
    return (
      <>
        {header}
        <ErrorState error={models.error} onRetry={() => void models.refetch()} />
      </>
    );
  const workflow = models.data.items.filter((m) => m.usage === 'workflow');
  const evaluation = models.data.items.filter((m) => m.usage === 'evaluation');
  return (
    <div className={`space-y-5 ${models.isPlaceholderData ? 'opacity-60 transition-opacity' : ''}`}>
      {header}
      {models.data.items.length === 0 ? (
        <Panel>
          <EmptyState title="No model calls in this window">
            Model calls are recorded by <code className="text-xs">llm</code> steps, by{' '}
            <code className="text-xs">ctx.llm()</code> in function steps, and by{' '}
            <code className="text-xs">span.recordModelCall()</code> in SDK-instrumented code.
          </EmptyState>
        </Panel>
      ) : (
        <>
          {workflow.length > 0 && (
            <ModelTable
              items={workflow}
              title="Application calls"
              description="Calls made by workflows and instrumented applications"
            />
          )}
          {evaluation.length > 0 && (
            <ModelTable
              items={evaluation}
              title="Evaluator calls"
              description="Judge and embedding calls made by model-based evaluators (not counted in trace cost)"
            />
          )}
        </>
      )}
    </div>
  );
}
