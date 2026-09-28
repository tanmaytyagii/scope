import { useEffect, useRef, useState } from 'react';
import { cx } from './cx.ts';
import { Check, Copy as CopyIcon } from './icons.tsx';

async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function useCopy(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const copy = (text: string) => {
    void writeClipboard(text).then((ok) => {
      if (!ok) return;
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    });
  };
  return [copied, copy];
}

export function CopyButton({
  text,
  label = 'Copy',
  className,
  showLabel = false,
}: {
  text: string;
  label?: string;
  className?: string;
  showLabel?: boolean;
}) {
  const [copied, copy] = useCopy();
  return (
    <button
      type="button"
      onClick={() => copy(text)}
      aria-label={copied ? 'Copied' : label}
      title={copied ? 'Copied' : label}
      className={cx(
        'inline-flex h-7 items-center gap-1.5 rounded-md px-1.5 text-xs text-fg-3 hover:bg-hover hover:text-fg',
        className,
      )}
    >
      {copied ? <Check size={14} className="text-good-fg" /> : <CopyIcon size={14} />}
      {showLabel && <span>{copied ? 'Copied' : label}</span>}
      <span className="sr-only" aria-live="polite">
        {copied ? 'Copied to clipboard' : ''}
      </span>
    </button>
  );
}

/** An identifier shown short, copied in full. */
export function IdChip({ id, length = 8 }: { id: string; length?: number }) {
  const [copied, copy] = useCopy();
  const short = id.includes('_') ? id.slice(0, id.indexOf('_') + 1 + length) : id.slice(0, length);
  return (
    <button
      type="button"
      onClick={() => copy(id)}
      title={copied ? 'Copied' : `Copy ${id}`}
      aria-label={`Copy id ${id}`}
      className="inline-flex items-center gap-1 rounded-sm font-mono text-xs text-fg-2 hover:bg-hover hover:text-fg"
    >
      {short}
      {copied ? (
        <Check size={12} className="text-good-fg" />
      ) : (
        <CopyIcon size={12} className="text-fg-3" />
      )}
    </button>
  );
}
