import { type ReactNode, useId } from 'react';
import { cx } from './cx.ts';

/** A section of a page; with a title, it is a landmark region named by that title. */
export function Panel({
  title,
  description,
  actions,
  children,
  className,
  bodyClassName,
  id,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  id?: string;
}) {
  const generated = useId();
  const headingId = title ? `${id ?? generated}-title` : undefined;
  return (
    <section
      id={id}
      aria-labelledby={title ? headingId : undefined}
      className={cx('rounded-lg border border-line bg-panel', className)}
    >
      {(title || actions) && (
        <header className="flex min-h-11 flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-4 py-2">
          <div className="min-w-0 flex-1">
            {title && (
              <h2 id={headingId} className="text-sm font-semibold text-fg">
                {title}
              </h2>
            )}
            {description && <p className="text-xs text-fg-3">{description}</p>}
          </div>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}

/** Key–value facts, e.g. run metadata. */
export function Facts({ items }: { items: Array<[ReactNode, ReactNode]> }) {
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1.5 text-sm">
      {items.map(([k, v], i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static list
        <div key={i} className="contents">
          <dt className="text-fg-3">{k}</dt>
          <dd className="min-w-0 break-words text-fg">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
