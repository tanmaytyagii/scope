/**
 * Status presentation. Status colors are reserved for good/bad meaning and always come with an
 * icon and a label, so no state is communicated by color alone.
 */
import type { EvaluationStatus, GateStatus, RunStatus } from '@scope-ai/protocol';
import type { ReactNode } from 'react';
import { cx } from './cx.ts';
import { Alert, Bolt, Check, Cross, Dot, Skip } from './icons.tsx';

export type Tone = 'good' | 'bad' | 'warn' | 'neutral' | 'info';

const TONES: Record<Tone, string> = {
  good: 'bg-good-wash text-good-fg',
  bad: 'bg-bad-wash text-bad-fg',
  warn: 'bg-warn-wash text-warn-fg',
  neutral: 'bg-sunken text-fg-2',
  info: 'bg-selected text-accent-fg',
};

export function Pill({
  tone = 'neutral',
  icon,
  children,
  className,
  title,
}: {
  tone?: Tone;
  icon?: ReactNode;
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cx(
        'forced-border inline-flex h-5 items-center gap-1 rounded-sm px-1.5 text-2xs font-medium whitespace-nowrap',
        TONES[tone],
        className,
      )}
    >
      {icon}
      {children}
    </span>
  );
}

type Outcome = 'passed' | 'failed' | 'errored' | 'error' | 'skipped' | 'ok' | 'none';

const OUTCOMES: Record<Outcome, { tone: Tone; label: string; icon: ReactNode }> = {
  passed: { tone: 'good', label: 'passed', icon: <Check size={12} /> },
  ok: { tone: 'good', label: 'ok', icon: <Check size={12} /> },
  failed: { tone: 'bad', label: 'failed', icon: <Cross size={12} /> },
  errored: { tone: 'bad', label: 'error', icon: <Bolt size={12} /> },
  error: { tone: 'bad', label: 'error', icon: <Bolt size={12} /> },
  skipped: { tone: 'neutral', label: 'skipped', icon: <Skip size={12} /> },
  none: { tone: 'neutral', label: 'not evaluated', icon: <Skip size={12} /> },
};

/** Evaluation, case or trace outcome. */
export function OutcomeBadge({
  outcome,
  label,
}: {
  outcome: Outcome | EvaluationStatus | null;
  label?: string;
}) {
  const o = OUTCOMES[(outcome ?? 'none') as Outcome] ?? OUTCOMES.none;
  return (
    <Pill tone={o.tone} icon={o.icon}>
      {label ?? o.label}
    </Pill>
  );
}

/** Result of a run: its gates, or its lifecycle state when gates did not decide it. */
export function RunResult({ status, gateStatus }: { status: RunStatus; gateStatus: GateStatus }) {
  if (status === 'running')
    return (
      <Pill tone="info" icon={<Dot size={12} />}>
        running
      </Pill>
    );
  if (status === 'failed')
    return (
      <Pill tone="bad" icon={<Bolt size={12} />}>
        error
      </Pill>
    );
  if (status === 'cancelled')
    return (
      <Pill tone="neutral" icon={<Skip size={12} />}>
        cancelled
      </Pill>
    );
  switch (gateStatus) {
    case 'passed':
      return (
        <Pill tone="good" icon={<Check size={12} />}>
          passed
        </Pill>
      );
    case 'failed':
      return (
        <Pill tone="bad" icon={<Cross size={12} />}>
          gates failed
        </Pill>
      );
    case 'warned':
      return (
        <Pill tone="warn" icon={<Alert size={12} />}>
          warnings
        </Pill>
      );
    default:
      return (
        <Pill tone="neutral" icon={<Check size={12} />}>
          completed
        </Pill>
      );
  }
}

/** A compact status glyph for dense rows (with an accessible label). */
export function StatusIcon({ outcome }: { outcome: Outcome | EvaluationStatus | null }) {
  const key = (outcome ?? 'none') as Outcome;
  const o = OUTCOMES[key] ?? OUTCOMES.none;
  const color = o.tone === 'good' ? 'text-good-fg' : o.tone === 'bad' ? 'text-bad-fg' : 'text-fg-3';
  const Icon =
    key === 'passed' || key === 'ok'
      ? Check
      : key === 'failed'
        ? Cross
        : key === 'error' || key === 'errored'
          ? Bolt
          : Skip;
  return (
    <span className={cx('inline-flex', color)} title={o.label}>
      <Icon size={14} label={o.label} />
    </span>
  );
}
