/**
 * ⌘K: jump to any page, a run by number, a trace by id, or search traces — without the mouse.
 */
import { Command } from 'cmdk';
import { Dialog } from 'radix-ui';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { allItems, useRuns } from '../api/queries.ts';
import { formatPercent, relativeTime } from '../lib/format.ts';
import { ArrowRight, Monitor, Moon, Search, Sun } from '../ui/icons.tsx';
import { NAV } from './nav.ts';
import { setTheme } from './theme.ts';

const itemClass =
  'flex h-9 cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-sm text-fg-2 data-[selected=true]:bg-selected data-[selected=true]:text-fg';
const groupClass =
  '[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pt-3 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-2xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-fg-3';

function RecentRuns({ go }: { go: (to: string) => void }) {
  const runs = allItems(useRuns({}, 8).data);
  if (runs.length === 0) return null;
  return (
    <Command.Group heading="Recent runs" className={groupClass}>
      {runs.map((run) => (
        <Command.Item
          key={run.id}
          value={`run ${run.number} ${run.workflow} ${run.variant ?? ''}`}
          onSelect={() => go(`/runs/${run.number}`)}
          className={itemClass}
        >
          <span className="tabular w-10 font-mono text-xs text-fg-3">#{run.number}</span>
          <span className="truncate">
            {run.workflow}
            {run.variant ? ` · ${run.variant}` : ''}
          </span>
          <span className="ml-auto text-xs text-fg-3">
            {formatPercent(run.passRate)} · {relativeTime(run.startedAt)}
          </span>
        </Command.Item>
      ))}
    </Command.Group>
  );
}

export function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const go = (to: string) => {
    onOpenChange(false);
    setSearch('');
    navigate(to);
  };
  const q = search.trim();
  const runNumber = /^#?(\d{1,7})$/.exec(q)?.[1];
  const traceId = /^[0-9a-f]{4,32}$/i.test(q) && !runNumber ? q.toLowerCase() : null;

  return (
    <Command.Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) setSearch('');
      }}
      label="Command palette"
      overlayClassName="fixed inset-0 z-40 bg-black/30"
      contentClassName="fixed top-[12vh] left-1/2 z-50 w-[min(640px,calc(100vw-2rem))] -translate-x-1/2 overflow-hidden rounded-lg border border-line bg-raised shadow-pop"
    >
      <Dialog.Title className="sr-only">Command palette</Dialog.Title>
      <Dialog.Description className="sr-only">
        Search pages, runs and traces, or type a run number or trace id.
      </Dialog.Description>
      <div className="flex items-center gap-2 border-b border-line px-3">
        <Search size={16} className="text-fg-3" />
        <Command.Input
          value={search}
          onValueChange={setSearch}
          placeholder="Go to a page, run #, trace id, or search traces…"
          className="h-12 w-full bg-transparent text-sm text-fg outline-none placeholder:text-fg-3"
        />
      </div>
      <Command.List className="max-h-[min(60vh,420px)] overflow-y-auto p-1.5">
        <Command.Empty className="px-3 py-6 text-center text-sm text-fg-3">
          Nothing matches. Try a run number or part of a trace id.
        </Command.Empty>
        {(runNumber || traceId || q) && (
          <Command.Group heading="Jump" className={groupClass} forceMount>
            {runNumber && (
              <Command.Item
                forceMount
                value={`open-run-${runNumber}`}
                onSelect={() => go(`/runs/${runNumber}`)}
                className={itemClass}
              >
                <ArrowRight size={14} /> Open run #{runNumber}
              </Command.Item>
            )}
            {traceId && (
              <Command.Item
                forceMount
                value={`open-trace-${traceId}`}
                onSelect={() => go(`/traces/${traceId}`)}
                className={itemClass}
              >
                <ArrowRight size={14} /> Open trace <code className="text-xs">{traceId}</code>
              </Command.Item>
            )}
            {q && (
              <Command.Item
                forceMount
                value={`search-traces-${q}`}
                onSelect={() => go(`/traces?q=${encodeURIComponent(q)}`)}
                className={itemClass}
              >
                <Search size={14} /> Search traces for “{q}”
              </Command.Item>
            )}
          </Command.Group>
        )}
        <Command.Group heading="Pages" className={groupClass}>
          {NAV.map((item) => (
            <Command.Item
              key={item.to}
              value={`${item.label} ${item.description}`}
              onSelect={() => go(item.to)}
              className={itemClass}
            >
              <item.icon size={16} />
              {item.label}
              <span className="ml-auto text-xs text-fg-3">{item.description}</span>
            </Command.Item>
          ))}
        </Command.Group>
        {open && <RecentRuns go={go} />}
        <Command.Group heading="Appearance" className={groupClass}>
          <Command.Item
            value="theme system"
            onSelect={() => {
              setTheme('system');
              onOpenChange(false);
            }}
            className={itemClass}
          >
            <Monitor size={16} /> Use system theme
          </Command.Item>
          <Command.Item
            value="theme light"
            onSelect={() => {
              setTheme('light');
              onOpenChange(false);
            }}
            className={itemClass}
          >
            <Sun size={16} /> Light theme
          </Command.Item>
          <Command.Item
            value="theme dark"
            onSelect={() => {
              setTheme('dark');
              onOpenChange(false);
            }}
            className={itemClass}
          >
            <Moon size={16} /> Dark theme
          </Command.Item>
        </Command.Group>
      </Command.List>
    </Command.Dialog>
  );
}
