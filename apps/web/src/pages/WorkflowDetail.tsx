/** A workflow: its quality over time, its variants, its versions and its current definition. */
import { Link, useParams } from 'react-router';
import { allItems, useRuns, useWorkflow } from '../api/queries.ts';
import { useTitle } from '../app/hooks.ts';
import { RunTrend } from '../components/RunTrend.tsx';
import { formatDateTime, formatDuration, relativeTime } from '../lib/format.ts';
import { CodeBlock } from '../ui/CodeBlock.tsx';
import { Meter, PageHeader } from '../ui/Figures.tsx';
import { Panel } from '../ui/Panel.tsx';
import { ErrorState, Loading } from '../ui/States.tsx';
import { RunResult } from '../ui/Status.tsx';
import { Table, TD, TH, THead, TR } from '../ui/Table.tsx';

export function WorkflowDetail() {
  const { name = '' } = useParams();
  useTitle(name);
  const workflow = useWorkflow(name);
  const runs = useRuns({ workflow: name }, 50);
  const items = allItems(runs.data);

  if (workflow.isPending) return <Loading rows={8} />;
  if (workflow.isError)
    return <ErrorState error={workflow.error} onRetry={() => void workflow.refetch()} />;
  const w = workflow.data;
  const completed = items.filter((r) => r.status === 'completed').reverse();

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow={
          <Link to="/workflows" className="hover:text-fg hover:underline">
            Workflows
          </Link>
        }
        title={w.name}
        meta={
          <>
            {w.description && <span>{w.description}</span>}
            {w.latest?.path && <code className="text-xs">{w.latest.path}</code>}
            <span>updated {relativeTime(w.updatedAt)}</span>
          </>
        }
        actions={
          <Link
            to={`/runs?workflow=${encodeURIComponent(w.name)}`}
            className="text-sm text-accent-fg hover:underline"
          >
            All runs of this workflow
          </Link>
        }
      />
      {completed.length > 0 && (
        <RunTrend
          runs={completed}
          showWorkflow={false}
          description={`Last ${completed.length} completed runs of ${w.name}, oldest first, all variants`}
        />
      )}
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Panel title="Recent runs">
          {items.length === 0 ? (
            <p className="px-4 py-5 text-sm text-fg-2">No runs yet.</p>
          ) : (
            <Table>
              <THead>
                <TH>Run</TH>
                <TH>Variant</TH>
                <TH>Result</TH>
                <TH align="right">Pass rate</TH>
                <TH align="right">p95</TH>
                <TH align="right">Started</TH>
              </THead>
              <tbody>
                {items.slice(0, 15).map((r) => (
                  <TR key={r.id} to={`/runs/${r.number}`}>
                    <TD>
                      <Link
                        to={`/runs/${r.number}`}
                        className="tabular font-medium text-fg hover:underline"
                      >
                        #{r.number}
                      </Link>
                    </TD>
                    <TD className="text-fg-2">{r.variant ?? 'default'}</TD>
                    <TD>
                      <RunResult status={r.status} gateStatus={r.gateStatus} />
                    </TD>
                    <TD align="right">
                      <Meter value={r.passRate} label={`Run #${r.number} pass rate`} />
                    </TD>
                    <TD align="right">{formatDuration(r.summary?.latency.p95Ms)}</TD>
                    <TD align="right" className="text-fg-3">
                      {relativeTime(r.startedAt)}
                    </TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          )}
        </Panel>
        <div className="space-y-5">
          <Panel title="Variants" description="Named parameter overrides that have been run">
            {w.variants.length === 0 ? (
              <p className="px-4 py-4 text-sm text-fg-2">
                Only the default parameters have run. Define{' '}
                <code className="text-xs">variants:</code> and run them with{' '}
                <code className="text-xs">scope run --all-variants</code>.
              </p>
            ) : (
              <ul className="divide-y divide-line">
                {w.variants.map((v) => (
                  <li key={v} className="flex items-center justify-between px-4 py-2 text-sm">
                    <span className="text-fg">{v}</span>
                    <Link
                      to={`/runs?workflow=${encodeURIComponent(w.name)}`}
                      className="text-xs text-accent-fg hover:underline"
                    >
                      Runs
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
          <Panel title="Versions" description="Content hashes of the workflow file as run">
            <ul className="divide-y divide-line">
              {w.versions.map((v, i) => (
                <li key={v.id} className="flex items-center gap-3 px-4 py-2 text-sm">
                  <code className="text-xs text-fg">{v.hash.slice(0, 12)}</code>
                  {i === 0 && <span className="text-2xs text-fg-3">latest</span>}
                  <span className="ml-auto text-xs text-fg-3" title={v.createdAt}>
                    {formatDateTime(v.createdAt)}
                  </span>
                </li>
              ))}
            </ul>
          </Panel>
        </div>
      </div>
      {w.latest && (
        <Panel
          title="Definition"
          description="The latest version, as run. Environment references are kept, never their values."
        >
          <div className="p-4">
            <CodeBlock label={w.latest.path ?? 'workflow.yaml'} text={w.latest.source} />
          </div>
        </Panel>
      )}
    </div>
  );
}
