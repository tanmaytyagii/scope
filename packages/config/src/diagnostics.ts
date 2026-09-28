/**
 * Configuration diagnostics: what is wrong, where, and how to fix it.
 */
import { type ErrorCode, ErrorCodes, ScopeError } from '@scope-ai/core';

export type Severity = 'error' | 'warning';

export interface Diagnostic {
  severity: Severity;
  message: string;
  hint?: string;
  file?: string;
  /** 1-based line and column of the offending node. */
  line?: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
  /** Location within the document, e.g. `steps[1].with.model`. */
  path?: string;
}

export type PathSegment = string | number;

export function formatPath(path: readonly PathSegment[]): string {
  let out = '';
  for (const seg of path) {
    if (typeof seg === 'number') out += `[${seg}]`;
    else if (/^[A-Za-z_][A-Za-z0-9_-]*$/.test(seg)) out += out ? `.${seg}` : seg;
    else out += `[${JSON.stringify(seg)}]`;
  }
  return out || '(root)';
}

export function hasErrors(diagnostics: readonly Diagnostic[]): boolean {
  return diagnostics.some((d) => d.severity === 'error');
}

/** Thrown when configuration cannot be used. Carries every diagnostic found, not just the first. */
export class ConfigError extends ScopeError {
  readonly diagnostics: Diagnostic[];
  /** Source text by file path, for rendering code frames. */
  readonly sources: Record<string, string>;

  constructor(
    diagnostics: Diagnostic[],
    sources: Record<string, string> = {},
    code: ErrorCode = ErrorCodes.configInvalid,
  ) {
    const errors = diagnostics.filter((d) => d.severity === 'error');
    const first = errors[0] ?? diagnostics[0];
    const where = first?.file
      ? `${first.file}${first.line ? `:${first.line}:${first.column ?? 1}` : ''}: `
      : '';
    const more = errors.length > 1 ? ` (and ${errors.length - 1} more)` : '';
    super(code, `${where}${first?.message ?? 'Invalid configuration'}${more}`, {
      hint: first?.hint,
    });
    this.name = 'ConfigError';
    this.diagnostics = diagnostics;
    this.sources = sources;
  }
}

export interface Styler {
  error: (s: string) => string;
  warning: (s: string) => string;
  dim: (s: string) => string;
  bold: (s: string) => string;
  accent: (s: string) => string;
}

const plain: Styler = {
  error: (s) => s,
  warning: (s) => s,
  dim: (s) => s,
  bold: (s) => s,
  accent: (s) => s,
};

/**
 * Renders a diagnostic with a source excerpt:
 *
 *   error  workflows/support.yaml:14:5
 *     steps[1]: unknown key "temprature"
 *
 *       13 │     type: llm
 *     > 14 │     temprature: 0
 *          │     ^^^^^^^^^^
 *
 *     hint: did you mean "temperature"?
 */
export function renderDiagnostic(
  diagnostic: Diagnostic,
  sourceText?: string,
  style: Styler = plain,
): string {
  const label = diagnostic.severity === 'error' ? style.error('error') : style.warning('warning');
  const location = diagnostic.file
    ? `${diagnostic.file}${diagnostic.line ? `:${diagnostic.line}:${diagnostic.column ?? 1}` : ''}`
    : '';
  const lines = [`${label}  ${style.bold(location)}`.trimEnd()];
  const prefix =
    diagnostic.path && diagnostic.path !== '(root)' ? `${style.accent(diagnostic.path)}: ` : '';
  lines.push(`  ${prefix}${diagnostic.message}`);

  if (sourceText && diagnostic.line) {
    const src = sourceText.split(/\r?\n/);
    const lineNo = diagnostic.line;
    const first = Math.max(1, lineNo - 1);
    const last = Math.min(src.length, lineNo + 1);
    const width = String(last).length;
    lines.push('');
    for (let n = first; n <= last; n++) {
      const marker = n === lineNo ? '>' : ' ';
      const text = src[n - 1] ?? '';
      lines.push(`  ${marker} ${style.dim(`${String(n).padStart(width)} │`)} ${text}`);
      if (n === lineNo) {
        const col = Math.max(1, diagnostic.column ?? 1);
        const endCol =
          diagnostic.endLine === lineNo && diagnostic.endColumn && diagnostic.endColumn > col
            ? diagnostic.endColumn
            : Math.max(col + 1, text.length + 1);
        const caret = `${' '.repeat(col - 1)}${'^'.repeat(Math.max(1, Math.min(endCol - col, 80)))}`;
        const color = diagnostic.severity === 'error' ? style.error : style.warning;
        lines.push(`    ${style.dim(`${' '.repeat(width)} │`)} ${color(caret)}`);
      }
    }
  }
  if (diagnostic.hint) {
    lines.push('');
    lines.push(`  ${style.accent('hint:')} ${diagnostic.hint}`);
  }
  return lines.join('\n');
}
