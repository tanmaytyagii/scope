/** The app frame: sidebar navigation, page outlet, command palette and shortcuts. */
import { useMemo, useState } from 'react';
import { NavLink, Outlet, useLocation, useRouteError } from 'react-router';
import { useProject, useServerInfo } from '../api/queries.ts';
import { Kbd, Segmented } from '../ui/Controls.tsx';
import { cx } from '../ui/cx.ts';
import { Close, Menu, Monitor, Moon, Reticle, Search, Sun } from '../ui/icons.tsx';
import { ErrorState } from '../ui/States.tsx';
import { CommandPalette } from './CommandPalette.tsx';
import { NAV } from './nav.ts';
import { MOD, ShortcutsDialog, useGlobalShortcuts } from './Shortcuts.tsx';
import { setTheme, type ThemePreference, useTheme } from './theme.ts';

function Wordmark() {
  return (
    <span className="flex items-center gap-2 text-fg">
      <Reticle size={18} />
      <span className="font-mono text-[13px] font-medium tracking-[0.22em]">SCOPE</span>
    </span>
  );
}

function ProjectName() {
  const project = useProject();
  const info = useServerInfo();
  if (!project.data) return <div className="h-4" />;
  return (
    <div className="truncate text-xs text-fg-3" title={project.data.project.slug}>
      {project.data.project.name}
      {info.data?.auth === 'none' ? ' · local' : ''}
    </div>
  );
}

function Sidebar({ onNavigate, onSearch }: { onNavigate?: () => void; onSearch: () => void }) {
  const theme = useTheme();
  const info = useServerInfo();
  return (
    <div className="flex h-full flex-col gap-1 px-3 py-4">
      <div className="mb-4 px-2">
        <Wordmark />
        <div className="mt-1.5">
          <ProjectName />
        </div>
      </div>
      <button
        type="button"
        onClick={onSearch}
        className="mb-3 flex h-8 items-center gap-2 rounded-md border border-line-strong bg-raised px-2.5 text-xs text-fg-3 hover:text-fg"
      >
        <Search size={14} />
        <span className="flex-1 text-left">Search or jump to…</span>
        <Kbd>{MOD}K</Kbd>
      </button>
      <nav aria-label="Main">
        <ul className="flex flex-col gap-0.5">
          {NAV.map((item) => (
            <li key={item.to}>
              <NavLink
                to={item.to}
                end={item.to === '/'}
                onClick={onNavigate}
                className={({ isActive }) =>
                  cx(
                    'flex h-8 items-center gap-2.5 rounded-md px-2.5 text-sm',
                    isActive
                      ? 'bg-selected font-medium text-fg'
                      : 'text-fg-2 hover:bg-hover hover:text-fg',
                  )
                }
              >
                <item.icon size={16} />
                {item.label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
      <div className="mt-auto flex flex-col gap-3 px-1 pt-4">
        <Segmented<ThemePreference>
          label="Theme"
          value={theme}
          onChange={setTheme}
          options={[
            { value: 'system', label: <Monitor size={14} label="System theme" />, title: 'System' },
            { value: 'light', label: <Sun size={14} label="Light theme" />, title: 'Light' },
            { value: 'dark', label: <Moon size={14} label="Dark theme" />, title: 'Dark' },
          ]}
        />
        <div className="text-2xs text-fg-3">
          SCOPE {info.data?.version ?? ''} · <kbd className="font-mono">?</kbd> shortcuts
        </div>
      </div>
    </div>
  );
}

export function Layout() {
  const [palette, setPalette] = useState(false);
  const [help, setHelp] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const location = useLocation();
  const handlers = useMemo(
    () => ({ openPalette: () => setPalette(true), openHelp: () => setHelp(true) }),
    [],
  );
  useGlobalShortcuts(handlers);

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[232px_1fr]">
      <a
        href="#main"
        className="sr-only z-50 rounded-md bg-raised px-3 py-2 focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        Skip to content
      </a>
      <div className="hidden border-r border-line bg-panel lg:block">
        <aside className="sticky top-0 h-screen">
          <Sidebar onSearch={() => setPalette(true)} />
        </aside>
      </div>

      <div className="flex h-12 items-center gap-3 border-b border-line bg-panel px-4 lg:hidden">
        <button
          type="button"
          aria-label="Open navigation"
          aria-expanded={drawer}
          onClick={() => setDrawer(true)}
          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-fg-2 hover:bg-hover"
        >
          <Menu size={16} />
        </button>
        <Wordmark />
        <button
          type="button"
          aria-label="Search"
          onClick={() => setPalette(true)}
          className="ml-auto inline-flex h-8 w-8 items-center justify-center rounded-md text-fg-2 hover:bg-hover"
        >
          <Search size={16} />
        </button>
      </div>
      {drawer && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button
            type="button"
            aria-label="Close navigation"
            className="absolute inset-0 bg-black/30"
            onClick={() => setDrawer(false)}
          />
          <div className="absolute inset-y-0 left-0 w-64 border-r border-line bg-panel">
            <button
              type="button"
              aria-label="Close navigation"
              onClick={() => setDrawer(false)}
              className="absolute top-3 right-3 inline-flex h-8 w-8 items-center justify-center rounded-md text-fg-2 hover:bg-hover"
            >
              <Close size={14} />
            </button>
            <Sidebar onNavigate={() => setDrawer(false)} onSearch={() => setPalette(true)} />
          </div>
        </div>
      )}

      <main id="main" tabIndex={-1} className="min-w-0 px-4 py-6 outline-none sm:px-6 lg:px-8">
        <div className="mx-auto max-w-[1440px]" key={location.pathname}>
          <Outlet />
        </div>
      </main>
      <CommandPalette open={palette} onOpenChange={setPalette} />
      <ShortcutsDialog open={help} onOpenChange={setHelp} />
    </div>
  );
}

/** Shown when rendering a route throws: a bug, reported with enough detail to file it. */
export function RouteError() {
  const error = useRouteError();
  return (
    <main className="mx-auto max-w-2xl pt-16">
      <ErrorState
        error={error instanceof Error ? error : new Error(String(error))}
        onRetry={() => window.location.reload()}
      />
      <p className="px-4 text-sm text-fg-3 sm:px-8">
        This is probably a bug in the SCOPE dashboard. Please report it at
        https://github.com/tanmaytyagii/scope/issues with the steps that led here.
      </p>
    </main>
  );
}
