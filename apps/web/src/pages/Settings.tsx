/**
 * Settings — what this server is, where its data lives, what it stores and how it prices.
 * Read-only: configuration lives in scope.yaml and environment variables, where it is reviewed
 * like code; the page says where each setting comes from.
 */

import { clearApiKey, getApiKey } from '../api/client.ts';
import { useApiKeys, useProject } from '../api/queries.ts';
import { useTitle } from '../app/hooks.ts';
import { setTheme, type ThemePreference, useTheme } from '../app/theme.ts';
import {
  formatBytes,
  formatDateTime,
  formatNumber,
  formatPrice,
  relativeTime,
} from '../lib/format.ts';
import { Button } from '../ui/Button.tsx';
import { Segmented } from '../ui/Controls.tsx';
import { IdChip } from '../ui/Copy.tsx';
import { PageHeader } from '../ui/Figures.tsx';
import { Facts, Panel } from '../ui/Panel.tsx';
import { ErrorState, Loading } from '../ui/States.tsx';
import { Pill } from '../ui/Status.tsx';
import { Table, TD, TH, THead, TR } from '../ui/Table.tsx';

function Keys({ auth }: { auth: 'none' | 'api-key' }) {
  const keys = useApiKeys();
  return (
    <Panel
      title="API keys"
      description={
        auth === 'none' ? (
          <>
            This local server does not require keys. Keys are used by <code>scope server</code>.
          </>
        ) : (
          <>
            Keys for SDKs (ingest) and the dashboard (read). Manage them with{' '}
            <code>scope keys</code>.
          </>
        )
      }
      actions={
        auth === 'api-key' && getApiKey() ? (
          <Button
            size="sm"
            onClick={() => {
              clearApiKey();
              window.location.reload();
            }}
          >
            Sign out
          </Button>
        ) : undefined
      }
    >
      {keys.isPending ? (
        <Loading rows={2} />
      ) : keys.isError ? (
        <ErrorState error={keys.error} />
      ) : keys.data.items.length === 0 ? (
        <p className="px-4 py-4 text-sm text-fg-2">
          No keys. Create one with{' '}
          <code className="text-xs">scope keys create --name ci --scope ingest</code>.
        </p>
      ) : (
        <Table>
          <THead>
            <TH>Name</TH>
            <TH>Key</TH>
            <TH>Scopes</TH>
            <TH>Created</TH>
            <TH>Last used</TH>
            <TH>Status</TH>
          </THead>
          <tbody>
            {keys.data.items.map((k) => (
              <TR key={k.id}>
                <TD className="text-fg">{k.name}</TD>
                <TD>
                  <code className="text-xs">{k.prefix}…</code>
                </TD>
                <TD className="text-fg-2">{k.scopes.join(', ')}</TD>
                <TD className="text-fg-3">{relativeTime(k.createdAt)}</TD>
                <TD className="text-fg-3">{k.lastUsedAt ? relativeTime(k.lastUsedAt) : 'never'}</TD>
                <TD>{k.revokedAt ? <Pill>revoked</Pill> : <Pill tone="good">active</Pill>}</TD>
              </TR>
            ))}
          </tbody>
        </Table>
      )}
    </Panel>
  );
}

export function Settings() {
  useTitle('Settings');
  const project = useProject();
  const theme = useTheme();
  if (project.isPending) return <Loading rows={8} />;
  if (project.isError)
    return <ErrorState error={project.error} onRetry={() => void project.refetch()} />;
  const p = project.data;
  return (
    <div className="space-y-5">
      <PageHeader
        title="Settings"
        meta="Configuration lives in scope.yaml and environment variables; this page shows what the server is using."
      />
      <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-2">
        <Panel title="Project">
          <div className="p-4">
            <Facts
              items={[
                ['Name', p.project.name],
                [
                  'Slug',
                  <code key="s" className="text-xs">
                    {p.project.slug}
                  </code>,
                ],
                ['Id', <IdChip key="i" id={p.project.id} length={10} />],
                ['Created', formatDateTime(p.project.createdAt)],
                ['Runs', formatNumber(p.stats.runs)],
                ['Traces', formatNumber(p.stats.traces)],
                ['Spans', formatNumber(p.stats.spans)],
                ['Evaluations', formatNumber(p.stats.evaluations)],
                ['Oldest trace', p.stats.oldestTrace ? formatDateTime(p.stats.oldestTrace) : '—'],
              ]}
            />
          </div>
        </Panel>
        <Panel title="Server and storage">
          <div className="p-4">
            <Facts
              items={[
                ['Version', `SCOPE ${p.server.version}`],
                [
                  'Authentication',
                  p.server.auth === 'none' ? (
                    <span key="a">
                      none — local <code className="text-xs">scope ui</code>, this machine only
                    </span>
                  ) : (
                    <span key="a">
                      API keys (<code className="text-xs">scope server</code>)
                    </span>
                  ),
                ],
                ['Database', p.server.storage.dialect === 'sqlite' ? 'SQLite' : 'PostgreSQL'],
                [
                  'Location',
                  <code key="l" className="text-xs break-all">
                    {p.server.storage.location}
                  </code>,
                ],
                [
                  'Schema',
                  p.server.migrations.pending.length
                    ? `${p.server.migrations.pending.length} pending migrations`
                    : `up to date (${p.server.migrations.applied.at(-1) ?? 'none'})`,
                ],
              ]}
            />
            <p className="mt-3 text-xs text-fg-3">
              Set the database with <code>SCOPE_DATABASE_URL</code> or <code>storage.url</code> in
              scope.yaml.
            </p>
          </div>
        </Panel>
        <Panel
          title="Privacy"
          description="Applied before anything is stored: in the SDK and engine, and again by this server"
        >
          <div className="p-4">
            <Facts
              items={[
                [
                  'Content capture',
                  p.privacy.captureContent
                    ? 'on — inputs and outputs are stored, after redaction'
                    : 'off — only structure, timing, tokens, costs and results are stored',
                ],
                [
                  'Payload limit',
                  `${formatBytes(p.privacy.maxPayloadBytes)} per field (larger values are truncated)`,
                ],
                [
                  'Redaction rules',
                  <span key="r" className="flex flex-wrap gap-1">
                    {p.privacy.redactionRules.map((r) => (
                      <code key={r} className="rounded-sm bg-sunken px-1 text-2xs">
                        {r}
                      </code>
                    ))}
                  </span>,
                ],
                ['Sensitive fields', p.privacy.sensitiveKeys.join(', ')],
              ]}
            />
            <p className="mt-3 text-xs text-fg-3">
              Redaction is pattern-based and therefore best effort. For regulated data, set{' '}
              <code>privacy.capture_content: false</code>.
            </p>
          </div>
        </Panel>
        <Panel title="Appearance">
          <div className="flex items-center justify-between gap-4 p-4 text-sm">
            <span className="text-fg-2">Theme</span>
            <Segmented<ThemePreference>
              label="Theme"
              value={theme}
              onChange={setTheme}
              options={[
                { value: 'system', label: 'System' },
                { value: 'light', label: 'Light' },
                { value: 'dark', label: 'Dark' },
              ]}
            />
          </div>
        </Panel>
      </div>
      <Keys auth={p.server.auth} />
      <Panel
        title="Pricing"
        description="USD per 1M tokens, used to estimate cost. Project entries (pricing: in scope.yaml) override the built-in table."
      >
        <Table className="max-h-[480px] overflow-y-auto">
          <THead>
            <TH>Model</TH>
            <TH align="right">Input</TH>
            <TH align="right">Output</TH>
            <TH align="right">Cache read</TH>
            <TH align="right">Cache write</TH>
            <TH>As of</TH>
            <TH>Source</TH>
          </THead>
          <tbody>
            {p.pricing.map((price) => (
              <TR key={price.model}>
                <TD>
                  <span className="flex items-center gap-2">
                    <code className="text-xs text-fg">{price.model}</code>
                    {price.origin === 'project' && <Pill tone="info">scope.yaml</Pill>}
                  </span>
                </TD>
                <TD align="right">{formatPrice(price.input)}</TD>
                <TD align="right">{formatPrice(price.output)}</TD>
                <TD align="right" className="text-fg-2">
                  {formatPrice(price.cacheRead)}
                </TD>
                <TD align="right" className="text-fg-2">
                  {formatPrice(price.cacheWrite)}
                </TD>
                <TD className="text-fg-2">{price.asOf}</TD>
                <TD className="max-w-60 truncate text-xs text-fg-3">
                  {/^https?:\/\//.test(price.source) ? (
                    <a
                      href={price.source}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="hover:underline"
                    >
                      {price.source.replace(/^https?:\/\//, '')}
                    </a>
                  ) : (
                    price.source
                  )}
                </TD>
              </TR>
            ))}
          </tbody>
        </Table>
      </Panel>
    </div>
  );
}
