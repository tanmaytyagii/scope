/**
 * Long content — prompts, responses, JSON payloads — readable at any length: wrapped by
 * default, collapsed past a height with an explicit "show all", copyable, and honest about
 * truncation and redaction done by the privacy layer.
 */
import type { JsonValue } from '@scope-ai/protocol';
import { useLayoutEffect, useRef, useState } from 'react';
import { formatBytes } from '../lib/format.ts';
import { displayText, redactionCount, truncation } from '../lib/payload.ts';
import { CopyButton } from './Copy.tsx';
import { cx } from './cx.ts';
import { Wrap } from './icons.tsx';

const COLLAPSED_HEIGHT = 280;

export function CodeBlock({
  value,
  text,
  label,
  className,
  collapse = true,
}: {
  /** A JSON payload; strings are shown as text. */
  value?: JsonValue | null;
  /** Raw text, when there is no payload. */
  text?: string;
  label?: string;
  className?: string;
  collapse?: boolean;
}) {
  const cut = value !== undefined ? truncation(value) : null;
  const content = cut ? cut.preview : text !== undefined ? text : displayText(value ?? null);
  const redactions = value !== undefined ? redactionCount(value ?? null) : 0;
  const [wrap, setWrap] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const pre = useRef<HTMLPreElement>(null);

  // Re-measure when the content or wrapping changes (both change the rendered height).
  // biome-ignore lint/correctness/useExhaustiveDependencies: the dependencies are the triggers
  useLayoutEffect(() => {
    const el = pre.current;
    if (el) setOverflows(el.scrollHeight > COLLAPSED_HEIGHT + 24);
  }, [content, wrap]);

  const lines = content.split('\n').length;
  return (
    <div className={cx('group relative rounded-md border border-line bg-sunken', className)}>
      <div className="flex h-8 items-center gap-2 border-b border-line px-2.5 text-2xs text-fg-2">
        {label && <span className="font-medium text-fg-2">{label}</span>}
        <span className="tabular">
          {lines.toLocaleString('en-US')} {lines === 1 ? 'line' : 'lines'}
        </span>
        {redactions > 0 && (
          <span
            title="Secrets matching SCOPE's redaction rules were replaced before storage."
            className="text-warn-fg"
          >
            {redactions} redacted
          </span>
        )}
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => setWrap((w) => !w)}
          aria-pressed={wrap}
          aria-label="Wrap long lines"
          title={wrap ? 'Wrapping lines' : 'Not wrapping lines'}
          className={cx(
            'inline-flex h-6 w-6 items-center justify-center rounded-sm hover:bg-hover',
            wrap ? 'text-fg-2' : 'text-fg-3',
          )}
        >
          <Wrap size={14} />
        </button>
        <CopyButton
          text={content}
          label={label ? `Copy ${label.toLowerCase()}` : 'Copy'}
          className="h-6"
        />
      </div>
      {cut && (
        <p className="border-b border-line bg-warn-wash px-2.5 py-1.5 text-xs text-warn-fg">
          Truncated before storage: the original was {formatBytes(cut.originalBytes)}, above the
          project’s <code>privacy.max_payload_bytes</code>. Showing the stored preview.
        </p>
      )}
      {/* biome-ignore lint/a11y/useSemanticElements: the scrollable <pre> itself is the labelled region */}
      <pre
        ref={pre}
        // Scrollable content must be reachable by keyboard: a labelled, focusable region.
        role="region"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: scrollable regions must be focusable (WCAG 2.1.1)
        tabIndex={0}
        aria-label={label ? `${label} content` : 'Content'}
        className={cx(
          'overflow-auto px-3 py-2.5 font-mono text-xs leading-5 text-fg',
          wrap ? 'break-words whitespace-pre-wrap' : 'whitespace-pre',
        )}
        style={collapse && !expanded ? { maxHeight: COLLAPSED_HEIGHT } : undefined}
      >
        {content || <span className="text-fg-3">(empty)</span>}
      </pre>
      {collapse && overflows && (
        <div className="border-t border-line px-2.5 py-1">
          <button
            type="button"
            onClick={() => setExpanded((e) => !e)}
            aria-expanded={expanded}
            className="rounded-sm px-1 text-xs font-medium text-accent-fg hover:bg-hover"
          >
            {expanded ? 'Collapse' : 'Show all'}
          </button>
        </div>
      )}
    </div>
  );
}
