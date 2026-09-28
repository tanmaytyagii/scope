/** Workflows — the definitions SCOPE has run, with their latest result. */
import { Link } from 'react-router';
import { useWorkflows } from '../api/queries.ts';
import { useTitle } from '../app/hooks.ts';
import { relativeTime } from '../lib/format.ts';
import { Meter, PageHeader } from '../ui/Figures.tsx';
import { Panel } from '../ui/Panel.tsx';
import { EmptyState, ErrorState, Loading } from '../ui/States.tsx';
import { RunResult } from '../ui/Status.tsx';
import { Table, TD, TH, THead, TR } from '../ui/Table.tsx';

export function Workflows() {
  useTitle('Workflows');
  const workflows = useWorkflows();
  return (
    <>
      <PageHeader
        title="Workflows"
        meta="Versioned by content: every change to a workflow file is recorded with the runs that used it."
      />
      <Panel>
        {workflows.isPending ? (
          <Loading rows={4} />
        ) : workflows.isError ? (
          <ErrorState error={workflows.error} onRetry={() => void workflows.refetch()} />
        ) : workflows.data.items.length === 0 ? (
          <EmptyState title="No workflows have run yet" command="scope run workflows/support.yaml">
            A workflow appears here after its first run.
          </EmptyState>
        ) : (
          <Table>
            <THead>
              <TH>Workflow</TH>
              <TH>Last run</TH>
              <TH align="right">Pass rate</TH>
              <TH align="right">Runs</TH>
              <TH align="right">Versions</TH>
              <TH align="right">Updated</TH>
            </THead>
            <tbody>
              {workflows.data.items.map((w) => (
                <TR key={w.id} to={`/workflows/${encodeURIComponent(w.name)}`}>
                  <TD className="max-w-md">
                    <Link
                      to={`/workflows/${encodeURIComponent(w.name)}`}
                      className="font-medium text-fg hover:underline"
                    >
                      {w.name}
                    </Link>
                    {w.description && (
                      <div className="truncate text-xs text-fg-3">{w.description}</div>
                    )}
                  </TD>
                  <TD>
                    {w.lastRun ? (
                      <span className="flex items-center gap-2">
                        <Link
                          to={`/runs/${w.lastRun.number}`}
                          className="tabular text-fg-2 hover:underline"
                        >
                          #{w.lastRun.number}
                        </Link>
                        <RunResult status={w.lastRun.status} gateStatus={w.lastRun.gateStatus} />
                      </span>
                    ) : (
                      <span className="text-fg-3">—</span>
                    )}
                  </TD>
                  <TD align="right">
                    <Meter value={w.lastRun?.passRate ?? null} label={`${w.name} last pass rate`} />
                  </TD>
                  <TD align="right">{w.runCount}</TD>
                  <TD align="right">{w.versionCount}</TD>
                  <TD align="right" className="text-fg-3">
                    {relativeTime(w.updatedAt)}
                  </TD>
                </TR>
              ))}
            </tbody>
          </Table>
        )}
      </Panel>
    </>
  );
}
