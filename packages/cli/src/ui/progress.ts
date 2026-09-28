/**
 * Run progress. On an interactive terminal: one updating status line. Elsewhere (CI logs,
 * redirected output): one line per finished case.
 */
import { formatDuration } from '@scope-ai/core';
import type { CaseExecution } from '@scope-ai/engine';
import type { Output } from './output.ts';
import { padEnd, truncate } from './style.ts';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export class Progress {
  readonly #out: Output;
  readonly #total: number;
  #done = 0;
  #passed = 0;
  #failed = 0;
  #errored = 0;
  #current = '';
  #frame = 0;
  #timer: ReturnType<typeof setInterval> | null = null;
  #width = 0;

  constructor(out: Output, total: number) {
    this.#out = out;
    this.#total = total;
    if (out.interactive) {
      this.#timer = setInterval(() => this.#render(), 80);
      this.#timer.unref?.();
    }
  }

  start(caseId: string): void {
    this.#current = caseId;
    this.#width = Math.max(this.#width, Math.min(caseId.length, 32));
  }

  complete(execution: CaseExecution): void {
    this.#done++;
    const failedEvals = execution.evaluations.filter(
      (e) => e.status === 'failed' || e.status === 'error',
    );
    const errored =
      execution.status === 'error' || execution.evaluations.some((e) => e.status === 'error');
    if (errored) this.#errored++;
    else if (failedEvals.length) this.#failed++;
    else this.#passed++;
    if (this.#out.interactive || this.#out.quiet || this.#out.json) return;
    const s = this.#out.errStyle;
    const sym = this.#out.sym;
    const icon = errored
      ? s.red(sym.error)
      : failedEvals.length
        ? s.red(sym.fail)
        : s.green(sym.pass);
    const detail =
      execution.status === 'error'
        ? s.red(truncate(execution.error?.message ?? 'failed', 80))
        : failedEvals.map((e) => s.red(e.evaluator)).join(' ');
    const counter = s.dim(
      `${String(this.#done).padStart(String(this.#total).length)}/${this.#total}`,
    );
    this.#out.stderr.write(
      `  ${counter} ${icon} ${padEnd(truncate(execution.caseId, 32), Math.max(this.#width, 12))}  ${s.dim(formatDuration(execution.durationMs).padStart(8))}  ${detail}\n`,
    );
  }

  #render(): void {
    const s = this.#out.errStyle;
    const frame = FRAMES[this.#frame++ % FRAMES.length] as string;
    const counts = [
      s.green(`${this.#out.sym.pass} ${this.#passed}`),
      this.#failed ? s.red(`${this.#out.sym.fail} ${this.#failed}`) : '',
      this.#errored ? s.red(`${this.#out.sym.error} ${this.#errored}`) : '',
    ]
      .filter(Boolean)
      .join('  ');
    const line = `  ${s.cyan(frame)} ${this.#done}/${this.#total}  ${counts}  ${s.dim(truncate(this.#current, 40))}`;
    this.#out.stderr.write(`\r\u001b[2K${line}`);
  }

  stop(): void {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
      this.#out.stderr.write('\r\u001b[2K');
    } else if (!this.#out.interactive && !this.#out.quiet && !this.#out.json && this.#done > 0) {
      this.#out.stderr.write('\n');
    }
  }
}
