import { useEffect } from 'react';
import { useSearchParams } from 'react-router';

/** Sets the document title for a page. */
export function useTitle(title: string | null | undefined): void {
  useEffect(() => {
    document.title = title ? `${title} · SCOPE` : 'SCOPE';
  }, [title]);
}

/**
 * Filters live in the URL, so every view is linkable and the back button works. Returns the
 * current values and a setter that merges changes (empty values are removed).
 */
export function useUrlState<K extends string>(
  keys: readonly K[],
): [Record<K, string>, (changes: Partial<Record<K, string | null | undefined>>) => void] {
  const [params, setParams] = useSearchParams();
  const values = Object.fromEntries(keys.map((k) => [k, params.get(k) ?? ''])) as Record<K, string>;
  const update = (changes: Partial<Record<K, string | null | undefined>>) => {
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        for (const [k, v] of Object.entries(changes) as Array<
          [string, string | null | undefined]
        >) {
          if (v === undefined || v === null || v === '') next.delete(k);
          else next.set(k, v);
        }
        return next;
      },
      { replace: true },
    );
  };
  return [values, update];
}

export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return (
    el.isContentEditable ||
    el.tagName === 'INPUT' ||
    el.tagName === 'TEXTAREA' ||
    el.tagName === 'SELECT'
  );
}
