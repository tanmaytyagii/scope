/**
 * Empty, error and loading states. Empty states say what would put data here — with the real
 * command — instead of showing placeholders.
 */
import type { ReactNode } from 'react';
import { ApiError } from '../api/client.ts';
import { Button } from './Button.tsx';
import { CopyButton } from './Copy.tsx';
import { cx } from './cx.ts';
import { Alert } from './icons.tsx';

export function EmptyState({
  title,
  children,
  command,
  className,
}: {
  title: string;
  children?: ReactNode;
  command?: string;
  className?: string;
}) {
  return (
    <div className={cx('flex flex-col items-start gap-2 px-4 py-10 sm:px-8', className)}>
      <h3 className="text-sm font-semibold text-fg">{title}</h3>
      {children && <div className="max-w-prose text-sm text-fg-2">{children}</div>}
      {command && (
        <div className="mt-1 flex max-w-full items-center gap-1 rounded-md border border-line bg-sunken py-1 pr-1 pl-3">
          <code className="overflow-x-auto text-xs whitespace-pre text-fg">{command}</code>
          <CopyButton text={command} label="Copy command" />
        </div>
      )}
    </div>
  );
}

export function ErrorState({
  error,
  onRetry,
  className,
}: {
  error: unknown;
  onRetry?: () => void;
  className?: string;
}) {
  const api = error instanceof ApiError ? error : null;
  const message = api?.message ?? (error as Error)?.message ?? 'Unexpected error';
  return (
    <div
      role="alert"
      className={cx('flex flex-col items-start gap-2 px-4 py-8 sm:px-8', className)}
    >
      <div className="flex items-center gap-2 text-bad-fg">
        <Alert size={16} />
        <h3 className="text-sm font-semibold">{message}</h3>
      </div>
      {api?.hint && <p className="max-w-prose text-sm text-fg-2">{api.hint}</p>}
      <div className="flex flex-wrap items-center gap-3 text-xs text-fg-3">
        {api && api.status > 0 && (
          <span>
            HTTP {api.status} · <code>{api.code}</code>
          </span>
        )}
        {api?.requestId && (
          <span className="inline-flex items-center gap-1">
            request <code>{api.requestId}</code>
            <CopyButton text={api.requestId} label="Copy request id" />
          </span>
        )}
      </div>
      {onRetry && (
        <Button size="sm" onClick={onRetry} className="mt-1">
          Retry
        </Button>
      )}
    </div>
  );
}

/** Placeholder lines for a first load (subsequent refetches keep the previous render). */
export function Loading({ rows = 4, label = 'Loading' }: { rows?: number; label?: string }) {
  return (
    <div role="status" className="space-y-2.5 px-4 py-4" aria-busy="true" aria-label={label}>
      {Array.from({ length: rows }, (_, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
          key={i}
          className="h-4 animate-pulse rounded-sm bg-sunken"
          style={{ width: `${88 - ((i * 17) % 40)}%` }}
        />
      ))}
    </div>
  );
}
