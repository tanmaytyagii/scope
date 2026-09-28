/** Form controls: segmented choice, select, search. Native elements, styled. */
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { cx } from './cx.ts';
import { Close, Search } from './icons.tsx';

/** A single choice among a few options (a radio group). */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: ReadonlyArray<{ value: T; label: ReactNode; title?: string }>;
  onChange: (value: T) => void;
  label: string;
}) {
  const name = useId();
  return (
    <fieldset className="inline-flex h-8 w-fit items-center rounded-md border border-line-strong bg-raised p-0.5">
      <legend className="sr-only">{label}</legend>
      {options.map((o) => (
        <label
          key={o.value}
          title={o.title}
          className={cx(
            'relative inline-flex h-full cursor-pointer items-center rounded-sm px-2.5 text-xs font-medium',
            'has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent',
            o.value === value ? 'bg-selected text-fg' : 'text-fg-3 hover:text-fg',
          )}
        >
          <input
            type="radio"
            name={name}
            value={o.value}
            checked={o.value === value}
            onChange={() => onChange(o.value)}
            className="sr-only"
          />
          {o.label}
        </label>
      ))}
    </fieldset>
  );
}

export function Select({
  label,
  value,
  onChange,
  options,
  className,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: ReadonlyArray<{ value: string; label: string }>;
  className?: string;
}) {
  const id = useId();
  return (
    <div className={cx('inline-flex items-center', className)}>
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cx(
          'h-8 max-w-52 cursor-pointer rounded-md border border-line-strong bg-raised pr-7 pl-2.5 text-xs',
          value ? 'text-fg' : 'text-fg-3',
        )}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/** Search box that reports its value after the user pauses typing. */
export function SearchInput({
  value,
  onChange,
  placeholder,
  label,
  className,
  inputRef,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  label: string;
  className?: string;
  inputRef?: React.Ref<HTMLInputElement>;
}) {
  const [draft, setDraft] = useState(value);
  const last = useRef(value);
  useEffect(() => {
    if (value !== last.current) {
      last.current = value;
      setDraft(value);
    }
  }, [value]);
  useEffect(() => {
    if (draft === last.current) return;
    const t = setTimeout(() => {
      last.current = draft;
      onChange(draft);
    }, 250);
    return () => clearTimeout(t);
  }, [draft, onChange]);
  return (
    <div
      className={cx(
        'relative inline-flex h-8 items-center rounded-md border border-line-strong bg-raised',
        'focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-accent',
        className,
      )}
    >
      <Search size={14} className="pointer-events-none absolute left-2.5 text-fg-3" />
      <input
        ref={inputRef}
        type="search"
        aria-label={label}
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && draft) {
            e.stopPropagation();
            setDraft('');
          }
        }}
        className="h-full w-full min-w-0 bg-transparent pr-7 pl-8 text-sm text-fg outline-none placeholder:text-fg-3 [&::-webkit-search-cancel-button]:hidden"
      />
      {draft && (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => setDraft('')}
          className="absolute right-1 inline-flex h-6 w-6 items-center justify-center rounded-sm text-fg-3 hover:bg-hover hover:text-fg"
        >
          <Close size={12} />
        </button>
      )}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded-sm border border-line-strong bg-raised px-1 font-mono text-2xs text-fg-2">
      {children}
    </kbd>
  );
}
