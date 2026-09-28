/**
 * `{{ … }}` templates.
 *
 *   {{ inputs.question }}
 *   {{ steps.retrieve.output.documents | length }}
 *   {{ params.style | default("concise") | upper }}
 *   {{ steps.answer.output.json | json(2) }}
 *
 * Expressions are dotted paths (with [0] or ["key"] indexing) or literals, followed by filters.
 * There is no arbitrary code execution. A string consisting of exactly one expression keeps the
 * value's type; otherwise values are interpolated as text.
 */
import { ErrorCodes, ScopeError, suggest } from '@scope-ai/core';

export type Literal = string | number | boolean | null;

export interface PathExpr {
  kind: 'path';
  segments: Array<string | number>;
}

export interface LiteralExpr {
  kind: 'literal';
  value: Literal;
}

export interface FilterCall {
  name: string;
  args: Literal[];
}

export interface Expression {
  source: string;
  base: PathExpr | LiteralExpr;
  filters: FilterCall[];
}

type Part = { kind: 'text'; text: string } | { kind: 'expr'; expr: Expression };

export interface CompiledTemplate {
  source: string;
  parts: Part[];
  /** True when the template is exactly one expression (type-preserving). */
  single: boolean;
}

export class TemplateError extends ScopeError {
  readonly expression: string;
  constructor(message: string, expression: string, hint?: string) {
    super(ErrorCodes.templateError, message, { hint, details: { expression } });
    this.name = 'TemplateError';
    this.expression = expression;
  }
}

// ─── Parsing ─────────────────────────────────────────────────────────────────────────────────

class Cursor {
  pos = 0;
  readonly text: string;
  constructor(text: string) {
    this.text = text;
  }
  get done(): boolean {
    return this.pos >= this.text.length;
  }
  peek(): string {
    return this.text[this.pos] ?? '';
  }
  skipSpace(): void {
    while (!this.done && /\s/.test(this.peek())) this.pos++;
  }
  eat(ch: string): boolean {
    if (this.peek() === ch) {
      this.pos++;
      return true;
    }
    return false;
  }
}

function parseString(c: Cursor, source: string): string {
  const quote = c.peek();
  c.pos++;
  let out = '';
  while (!c.done && c.peek() !== quote) {
    if (c.peek() === '\\') {
      c.pos++;
      const esc = c.peek();
      out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc;
      c.pos++;
      continue;
    }
    out += c.peek();
    c.pos++;
  }
  if (!c.eat(quote)) throw new TemplateError(`Unterminated string in {{ ${source} }}`, source);
  return out;
}

function parseLiteral(c: Cursor, source: string): Literal | undefined {
  const ch = c.peek();
  if (ch === '"' || ch === "'") return parseString(c, source);
  const rest = c.text.slice(c.pos);
  const num = /^-?\d+(?:\.\d+)?/.exec(rest);
  if (num) {
    c.pos += num[0].length;
    return Number(num[0]);
  }
  for (const [word, value] of [
    ['true', true],
    ['false', false],
    ['null', null],
  ] as const) {
    if (rest.startsWith(word) && !/[\w]/.test(rest[word.length] ?? '')) {
      c.pos += word.length;
      return value;
    }
  }
  return undefined;
}

function parseIdent(c: Cursor): string | undefined {
  const m = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(c.text.slice(c.pos));
  if (!m) return undefined;
  c.pos += m[0].length;
  return m[0];
}

function parseExpression(raw: string): Expression {
  const source = raw.trim();
  const c = new Cursor(source);
  c.skipSpace();
  let base: PathExpr | LiteralExpr;
  const literal = parseLiteral(c, source);
  if (literal !== undefined) {
    base = { kind: 'literal', value: literal };
  } else {
    const first = parseIdent(c);
    if (!first) throw new TemplateError(`Expected a path or a value in {{ ${source} }}`, source);
    const segments: Array<string | number> = [first];
    for (;;) {
      if (c.eat('.')) {
        const ident = parseIdent(c) ?? /^\d+/.exec(c.text.slice(c.pos))?.[0];
        if (!ident) throw new TemplateError(`Expected a name after "." in {{ ${source} }}`, source);
        if (/^\d+$/.test(ident)) {
          c.pos += ident.length;
          segments.push(Number(ident));
        } else segments.push(ident);
      } else if (c.eat('[')) {
        c.skipSpace();
        const key = parseLiteral(c, source);
        c.skipSpace();
        if ((typeof key !== 'string' && typeof key !== 'number') || !c.eat(']')) {
          throw new TemplateError(`Expected [number] or ["key"] in {{ ${source} }}`, source);
        }
        segments.push(key);
      } else break;
    }
    base = { kind: 'path', segments };
  }

  const filters: FilterCall[] = [];
  for (;;) {
    c.skipSpace();
    if (c.done) break;
    if (!c.eat('|')) {
      throw new TemplateError(
        `Unexpected "${c.text.slice(c.pos)}" in {{ ${source} }}`,
        source,
        'Templates support paths, literals and filters, e.g. {{ inputs.name | upper }}. Put logic in a function step.',
      );
    }
    c.skipSpace();
    const name = parseIdent(c);
    if (!name)
      throw new TemplateError(`Expected a filter name after "|" in {{ ${source} }}`, source);
    const args: Literal[] = [];
    c.skipSpace();
    if (c.eat('(')) {
      c.skipSpace();
      if (!c.eat(')')) {
        for (;;) {
          c.skipSpace();
          const arg = parseLiteral(c, source);
          if (arg === undefined)
            throw new TemplateError(`Filter arguments must be literals in {{ ${source} }}`, source);
          args.push(arg);
          c.skipSpace();
          if (c.eat(')')) break;
          if (!c.eat(','))
            throw new TemplateError(`Expected "," or ")" in {{ ${source} }}`, source);
        }
      }
    }
    if (!(name in FILTERS)) {
      const guess = suggest(name, Object.keys(FILTERS));
      throw new TemplateError(
        `Unknown filter "${name}" in {{ ${source} }}`,
        source,
        guess
          ? `Did you mean "${guess}"?`
          : `Available filters: ${Object.keys(FILTERS).join(', ')}.`,
      );
    }
    filters.push({ name, args });
  }
  return { source, base, filters };
}

const cache = new Map<string, CompiledTemplate>();

export function compileTemplate(source: string): CompiledTemplate {
  const cached = cache.get(source);
  if (cached) return cached;
  const parts: Part[] = [];
  let pos = 0;
  while (pos < source.length) {
    const open = source.indexOf('{{', pos);
    if (open === -1) {
      parts.push({ kind: 'text', text: source.slice(pos) });
      break;
    }
    if (open > pos) parts.push({ kind: 'text', text: source.slice(pos, open) });
    const close = findClose(source, open + 2);
    if (close === -1) {
      throw new TemplateError(
        `Unclosed "{{" in template`,
        source.slice(open, open + 40),
        'Close the expression with "}}". To write a literal "{{", use {{ "{{" }}.',
      );
    }
    parts.push({ kind: 'expr', expr: parseExpression(source.slice(open + 2, close)) });
    pos = close + 2;
  }
  const single = parts.length === 1 && parts[0]?.kind === 'expr';
  const compiled: CompiledTemplate = { source, parts, single };
  if (cache.size > 5000) cache.clear();
  cache.set(source, compiled);
  return compiled;
}

/** Finds the matching "}}", skipping over quoted strings inside the expression. */
function findClose(source: string, from: number): number {
  let quote: string | null = null;
  for (let i = from; i < source.length - 1; i++) {
    const ch = source[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '}' && source[i + 1] === '}') return i;
  }
  return -1;
}

export function isTemplate(value: string): boolean {
  return value.includes('{{');
}

// ─── Evaluation ──────────────────────────────────────────────────────────────────────────────

export type TemplateScope = Readonly<Record<string, unknown>>;

const MISSING = Symbol('missing');

function describeAvailable(value: unknown): string[] {
  if (value && typeof value === 'object' && !Array.isArray(value)) return Object.keys(value);
  return [];
}

function lookup(scope: TemplateScope, expr: PathExpr, source: string, lenient: boolean): unknown {
  let current: unknown = scope;
  const walked: Array<string | number> = [];
  for (const seg of expr.segments) {
    const container = current;
    let next: unknown = MISSING;
    if (Array.isArray(container) && typeof seg === 'number') {
      next = seg < container.length ? container[seg] : MISSING;
    } else if (
      container !== null &&
      typeof container === 'object' &&
      Object.hasOwn(container, seg)
    ) {
      next = (container as Record<string | number, unknown>)[seg];
    }
    if (next === MISSING || next === undefined) {
      if (lenient) return undefined;
      const where = walked.length ? walked.join('.') : 'the template scope';
      const available = describeAvailable(container);
      const guess = typeof seg === 'string' ? suggest(seg, available) : undefined;
      throw new TemplateError(
        `{{ ${source} }}: "${String(seg)}" does not exist in ${where}`,
        source,
        guess
          ? `Did you mean "${guess}"?`
          : available.length
            ? `Available: ${available.slice(0, 12).join(', ')}${available.length > 12 ? ', …' : ''}. Use | default(...) for optional values.`
            : 'Use | default(...) for optional values.',
      );
    }
    walked.push(seg);
    current = next;
  }
  return current;
}

/** Text form of a value: strings verbatim, objects with a `text` field → that text, else JSON. */
export function asText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof (value as { text?: unknown }).text === 'string'
  ) {
    return (value as { text: string }).text;
  }
  return JSON.stringify(value, null, 2);
}

type FilterFn = (value: unknown, args: Literal[], source: string) => unknown;

const FILTERS: Record<string, FilterFn> = {
  json: (v, [indent]) =>
    JSON.stringify(v ?? null, null, typeof indent === 'number' ? indent : undefined),
  text: (v) => asText(v),
  default: (v, [fallback]) => (v === undefined || v === null || v === '' ? fallback : v),
  join: (v, [sep], source) => {
    if (!Array.isArray(v)) throw new TemplateError(`{{ ${source} }}: join expects a list`, source);
    return v.map(asText).join(typeof sep === 'string' ? sep : ', ');
  },
  lower: (v) => asText(v).toLowerCase(),
  upper: (v) => asText(v).toUpperCase(),
  trim: (v) => asText(v).trim(),
  truncate: (v, [n]) => {
    const text = asText(v);
    const limit = typeof n === 'number' ? n : 200;
    return text.length > limit ? `${text.slice(0, limit)}…` : text;
  },
  length: (v) => {
    if (typeof v === 'string' || Array.isArray(v)) return v.length;
    if (v && typeof v === 'object') return Object.keys(v).length;
    return 0;
  },
  first: (v) => (Array.isArray(v) ? v[0] : v),
  last: (v) => (Array.isArray(v) ? v[v.length - 1] : v),
  number: (v, _args, source) => {
    const n = typeof v === 'number' ? v : Number(asText(v));
    if (!Number.isFinite(n))
      throw new TemplateError(`{{ ${source} }}: "${asText(v)}" is not a number`, source);
    return n;
  },
};

export const FILTER_NAMES: readonly string[] = Object.keys(FILTERS);

export function evaluateExpression(expr: Expression, scope: TemplateScope): unknown {
  const lenient = expr.filters[0]?.name === 'default';
  let value =
    expr.base.kind === 'literal' ? expr.base.value : lookup(scope, expr.base, expr.source, lenient);
  for (const f of expr.filters) value = (FILTERS[f.name] as FilterFn)(value, f.args, expr.source);
  return value;
}

export function renderTemplate(source: string, scope: TemplateScope): unknown {
  if (!isTemplate(source)) return source;
  const compiled = compileTemplate(source);
  if (compiled.single)
    return evaluateExpression((compiled.parts[0] as { expr: Expression }).expr, scope);
  let out = '';
  for (const part of compiled.parts) {
    out += part.kind === 'text' ? part.text : asText(evaluateExpression(part.expr, scope));
  }
  return out;
}

/** Recursively renders every string in a JSON-like structure. */
export function renderDeep(value: unknown, scope: TemplateScope): unknown {
  if (typeof value === 'string') return renderTemplate(value, scope);
  if (Array.isArray(value)) return value.map((v) => renderDeep(v, scope));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = renderDeep(v, scope);
    return out;
  }
  return value;
}

// ─── Static analysis ─────────────────────────────────────────────────────────────────────────

export interface TemplateReference {
  segments: Array<string | number>;
  optional: boolean;
  expression: string;
}

/** Lists the paths a template reads. Throws TemplateError on syntax errors. */
export function templateReferences(source: string): TemplateReference[] {
  if (!isTemplate(source)) return [];
  const refs: TemplateReference[] = [];
  for (const part of compileTemplate(source).parts) {
    if (part.kind === 'expr' && part.expr.base.kind === 'path') {
      refs.push({
        segments: part.expr.base.segments,
        optional: part.expr.filters[0]?.name === 'default',
        expression: part.expr.source,
      });
    }
  }
  return refs;
}

/** Visits every string inside a JSON-like value with its path. */
export function forEachString(
  value: unknown,
  visit: (text: string, path: Array<string | number>) => void,
  path: Array<string | number> = [],
): void {
  if (typeof value === 'string') visit(value, path);
  else if (Array.isArray(value)) {
    for (const [i, v] of value.entries()) forEachString(v, visit, [...path, i]);
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) forEachString(v, visit, [...path, k]);
  }
}
