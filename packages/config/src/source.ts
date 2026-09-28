/**
 * YAML parsing with source positions, so every diagnostic can point at a line and column.
 */
import { isMap, isPair, isScalar, isSeq, LineCounter, type Node, parseDocument } from 'yaml';
import type { Diagnostic, PathSegment } from './diagnostics.ts';

export interface SourceRange {
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
}

export interface SourceFile {
  path: string;
  text: string;
  /**
   * Finds the source range for a document path. With `key: true`, returns the range of the
   * mapping key rather than its value. When the path does not exist, returns the deepest
   * existing ancestor (useful for "missing key" errors).
   */
  locate(path: readonly PathSegment[], options?: { key?: boolean }): SourceRange | null;
}

export interface ParsedYaml {
  data: unknown;
  source: SourceFile;
  diagnostics: Diagnostic[];
}

export function parseYaml(text: string, path: string): ParsedYaml {
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { lineCounter, prettyErrors: true, uniqueKeys: true });
  const diagnostics: Diagnostic[] = [];

  const toRange = (
    range: readonly [number, number, number] | null | undefined,
  ): SourceRange | null => {
    if (!range) return null;
    const start = lineCounter.linePos(range[0]);
    const end = lineCounter.linePos(range[1]);
    return { line: start.line, column: start.col, endLine: end.line, endColumn: end.col };
  };

  for (const error of doc.errors) {
    const pos = error.linePos?.[0];
    const end = error.linePos?.[1];
    const diagnostic: Diagnostic = {
      severity: 'error',
      message: `YAML syntax error: ${error.message.split('\n')[0]?.replace(/ at line \d+, column \d+:?$/, '')}`,
      file: path,
      hint: yamlHint(error.code),
    };
    if (pos) {
      diagnostic.line = pos.line;
      diagnostic.column = pos.col;
    }
    if (end) {
      diagnostic.endLine = end.line;
      diagnostic.endColumn = end.col;
    }
    diagnostics.push(diagnostic);
  }
  for (const warning of doc.warnings) {
    const pos = warning.linePos?.[0];
    diagnostics.push({
      severity: 'warning',
      message: warning.message.split('\n')[0] ?? warning.message,
      file: path,
      ...(pos ? { line: pos.line, column: pos.col } : {}),
    });
  }

  const locate: SourceFile['locate'] = (segments, options = {}) => {
    let node: unknown = doc.contents;
    let best: SourceRange | null = toRange((node as Node | null)?.range);
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const last = i === segments.length - 1;
      if (isMap(node)) {
        const pair = node.items.find(
          (p) => isPair(p) && isScalar(p.key) && String(p.key.value) === String(seg),
        );
        if (!pair) return best;
        if (last && options.key) return toRange((pair.key as Node).range) ?? best;
        node = pair.value;
        best =
          toRange((pair.value as Node | null)?.range) ?? toRange((pair.key as Node).range) ?? best;
      } else if (isSeq(node) && typeof seg === 'number') {
        const item = node.items[seg];
        if (!item) return best;
        node = item;
        best = toRange((item as Node).range) ?? best;
      } else {
        return best;
      }
    }
    return best;
  };

  let data: unknown = null;
  if (doc.errors.length === 0) {
    try {
      data = doc.toJS({ maxAliasCount: 100 });
    } catch (error) {
      diagnostics.push({
        severity: 'error',
        message: `YAML could not be converted: ${(error as Error).message}`,
        file: path,
      });
    }
  }
  return { data, source: { path, text, locate }, diagnostics };
}

function yamlHint(code: string): string | undefined {
  switch (code) {
    case 'DUPLICATE_KEY':
      return 'Each key may appear only once in a mapping. Remove or rename the duplicate.';
    case 'BAD_INDENT':
    case 'MISSING_CHAR':
      return 'Check indentation: nested keys must be indented consistently with spaces, not tabs.';
    case 'TAB_AS_INDENT':
      return 'YAML does not allow tabs for indentation. Replace tabs with spaces.';
    case 'MULTILINE_IMPLICIT_KEY':
      return 'A key cannot span lines. If this is a long string, use a block scalar ("|" or ">").';
    default:
      return 'Values containing ": " or starting with "{", "[", "*" or "&" need quotes.';
  }
}

/** Attaches a source position to a diagnostic when the path can be located. */
export function positioned(
  source: SourceFile,
  path: readonly PathSegment[],
  diagnostic: Omit<Diagnostic, 'file' | 'line' | 'column' | 'endLine' | 'endColumn'>,
  options: { key?: boolean } = {},
): Diagnostic {
  const range = source.locate(path, options);
  return {
    ...diagnostic,
    file: source.path,
    ...(range
      ? {
          line: range.line,
          column: range.column,
          endLine: range.endLine,
          endColumn: range.endColumn,
        }
      : {}),
  };
}
