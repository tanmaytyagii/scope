/** Global keyboard shortcuts and the "?" help dialog that lists them. */
import { Dialog } from 'radix-ui';
import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router';
import { Kbd } from '../ui/Controls.tsx';
import { Close } from '../ui/icons.tsx';
import { isTypingTarget } from './hooks.ts';
import { NAV } from './nav.ts';

export const MOD =
  typeof navigator !== 'undefined' && /Mac|iP(hone|ad)/.test(navigator.platform) ? '⌘' : 'Ctrl';

export function useGlobalShortcuts(handlers: {
  openPalette: () => void;
  openHelp: () => void;
}): void {
  const navigate = useNavigate();
  const pending = useRef<number>(0);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        handlers.openPalette();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return;
      if (e.key === '/') {
        const search = document.querySelector<HTMLInputElement>('[data-page-search] input');
        e.preventDefault();
        if (search) search.focus();
        else handlers.openPalette();
        return;
      }
      if (e.key === '?') {
        e.preventDefault();
        handlers.openHelp();
        return;
      }
      if (e.key === 'g') {
        pending.current = Date.now();
        return;
      }
      if (Date.now() - pending.current < 1200) {
        const item = NAV.find((n) => n.key === e.key);
        pending.current = 0;
        if (item) {
          e.preventDefault();
          navigate(item.to);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handlers, navigate]);
}

const GENERAL: Array<[string[], string]> = [
  [[MOD, 'K'], 'Command palette'],
  [['/'], 'Search this page'],
  [['?'], 'Keyboard shortcuts'],
];

const TRACE: Array<[string[], string]> = [
  [['↑', '↓'], 'Previous / next span'],
  [['←', '→'], 'Collapse / expand span'],
  [['Home', 'End'], 'First / last span'],
];

export function ShortcutsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const row = ([keys, label]: [string[], string]) => (
    <div key={label} className="flex items-center justify-between py-1.5 text-sm">
      <span className="text-fg-2">{label}</span>
      <span className="flex gap-1">
        {keys.map((k) => (
          <Kbd key={k}>{k}</Kbd>
        ))}
      </span>
    </div>
  );
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/30" />
        <Dialog.Content className="fixed top-[12vh] left-1/2 z-50 w-[min(480px,calc(100vw-2rem))] -translate-x-1/2 rounded-lg border border-line bg-raised p-5 shadow-pop">
          <div className="mb-3 flex items-center justify-between">
            <Dialog.Title className="text-base font-semibold text-fg">
              Keyboard shortcuts
            </Dialog.Title>
            <Dialog.Close
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-fg-3 hover:bg-hover hover:text-fg"
              aria-label="Close"
            >
              <Close size={14} />
            </Dialog.Close>
          </div>
          <Dialog.Description className="sr-only">
            Shortcuts work anywhere except while typing.
          </Dialog.Description>
          <div className="divide-y divide-line">
            {GENERAL.map(row)}
            {NAV.map((n) => row([['g', n.key], `Go to ${n.label}`]))}
          </div>
          <h3 className="mt-4 mb-1 text-xs font-medium text-fg-3">Trace explorer</h3>
          <div className="divide-y divide-line">{TRACE.map(row)}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
