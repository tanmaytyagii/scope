/**
 * Output routing. Human output goes to stdout; diagnostics, progress and warnings to stderr.
 * With --json, stdout carries exactly one JSON document and nothing else.
 */
import { colorEnabled, createStyle, type Style, type Symbols, symbols } from './style.ts';

export interface OutputOptions {
  json?: boolean;
  quiet?: boolean;
  verbose?: boolean;
  color?: boolean;
  stdout?: NodeJS.WriteStream;
  stderr?: NodeJS.WriteStream;
}

export class Output {
  readonly json: boolean;
  readonly quiet: boolean;
  readonly verbose: boolean;
  /** Styling for stdout. */
  readonly style: Style;
  /** Styling for stderr. */
  readonly errStyle: Style;
  readonly sym: Symbols;
  readonly stdout: NodeJS.WriteStream;
  readonly stderr: NodeJS.WriteStream;

  constructor(options: OutputOptions = {}) {
    this.json = options.json ?? false;
    this.quiet = options.quiet ?? false;
    this.verbose = options.verbose ?? false;
    this.stdout = options.stdout ?? process.stdout;
    this.stderr = options.stderr ?? process.stderr;
    this.style = createStyle(!this.json && colorEnabled(this.stdout, options.color));
    this.errStyle = createStyle(colorEnabled(this.stderr, options.color));
    this.sym = symbols();
  }

  /** Human-readable output on stdout (suppressed in --json and --quiet modes). */
  print(text = ''): void {
    if (this.json || this.quiet) return;
    this.stdout.write(`${text}\n`);
  }

  /** Primary result on stdout that should appear even with --quiet (not with --json). */
  result(text: string): void {
    if (this.json) return;
    this.stdout.write(`${text}\n`);
  }

  /** The single JSON document for --json mode. */
  emitJson(value: unknown): void {
    if (!this.json) return;
    this.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  }

  /** Diagnostics and notices on stderr. */
  info(text: string): void {
    if (this.quiet) return;
    this.stderr.write(`${text}\n`);
  }

  warn(text: string): void {
    this.stderr.write(`${this.errStyle.yellow('warning')}  ${text}\n`);
  }

  debug(text: string): void {
    if (this.verbose) this.stderr.write(`${this.errStyle.dim(`debug  ${text}`)}\n`);
  }

  get interactive(): boolean {
    return Boolean(this.stderr.isTTY) && !this.json && !this.quiet && process.env.CI === undefined;
  }
}
