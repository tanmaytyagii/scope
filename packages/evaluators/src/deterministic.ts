/**
 * Deterministic evaluators: verifiable rules. Same input, same result, and the result is a fact.
 */
import {
  asText,
  formatDuration,
  formatUsd,
  isJsonObject,
  type JsonValue,
  stableStringify,
} from '@scope-ai/core';
import { Ajv, type ErrorObject } from 'ajv';
import { z } from 'zod';
import { defineEvaluator, type EvaluatorOutcome } from './types.ts';

const stringOrList = z.union([z.string(), z.array(z.string()).min(1)]);

function normalizeText(
  text: string,
  opts: { caseSensitive: boolean; trim: boolean; collapseWhitespace: boolean },
): string {
  let out = text;
  if (opts.trim) out = out.trim();
  if (opts.collapseWhitespace) out = out.replace(/\s+/g, ' ');
  if (!opts.caseSensitive) out = out.toLowerCase();
  return out;
}

function preview(text: string, max = 120): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

const noExpected: EvaluatorOutcome = {
  score: null,
  skipped: true,
  reason: 'The case has no expected value to compare against.',
};

export const exactMatch = defineEvaluator({
  type: 'exact_match',
  kind: 'deterministic',
  description:
    'The output equals the expected value (strings after optional normalization; structures by deep equality).',
  requires: ['expected'],
  argsSchema: z.strictObject({
    case_sensitive: z.boolean().default(true),
    trim: z.boolean().default(true),
    collapse_whitespace: z.boolean().default(true),
  }),
  evaluate({ output, expected, args }): EvaluatorOutcome {
    if (expected === null) return noExpected;
    const structured =
      typeof expected === 'object' && typeof output === 'object' && output !== null;
    if (structured) {
      const equal = stableStringify(output as JsonValue) === stableStringify(expected);
      return {
        score: equal ? 1 : 0,
        reason: equal
          ? 'Output equals the expected value.'
          : 'Output differs from the expected value.',
      };
    }
    const opts = {
      caseSensitive: args.case_sensitive,
      trim: args.trim,
      collapseWhitespace: args.collapse_whitespace,
    };
    const a = normalizeText(asText(output), opts);
    const b = normalizeText(asText(expected), opts);
    const equal = a === b;
    return {
      score: equal ? 1 : 0,
      reason: equal
        ? 'Output matches the expected text.'
        : `Expected "${preview(asText(expected))}", got "${preview(asText(output))}".`,
    };
  },
});

function needles(
  value: string | string[] | undefined,
  expected: JsonValue | null,
): string[] | null {
  if (value !== undefined) return Array.isArray(value) ? value : [value];
  if (expected === null) return null;
  if (Array.isArray(expected)) return expected.map((e) => asText(e));
  return [asText(expected)];
}

export const contains = defineEvaluator({
  type: 'contains',
  kind: 'deterministic',
  description: 'The output contains the required strings (from `value`, or the expected value).',
  argsSchema: z.strictObject({
    value: stringOrList.optional(),
    all: z.boolean().default(true),
    case_sensitive: z.boolean().default(false),
  }),
  evaluate({ output, expected, args }): EvaluatorOutcome {
    const required = needles(args.value, expected);
    if (!required || required.length === 0)
      return {
        ...noExpected,
        reason: 'Nothing to look for: set `value` or give the case an expected value.',
      };
    const haystack = args.case_sensitive ? asText(output) : asText(output).toLowerCase();
    const found = required.filter((n) =>
      haystack.includes(args.case_sensitive ? n : n.toLowerCase()),
    );
    const missing = required.filter((n) => !found.includes(n));
    const passed = args.all ? missing.length === 0 : found.length > 0;
    return {
      score: found.length / required.length,
      passed,
      reason: passed
        ? `Found ${found.length} of ${required.length} required ${required.length === 1 ? 'string' : 'strings'}.`
        : args.all
          ? `Missing: ${missing.map((m) => `"${preview(m, 60)}"`).join(', ')}.`
          : 'None of the strings were found.',
      metadata: { found, missing },
    };
  },
});

export const notContains = defineEvaluator({
  type: 'not_contains',
  kind: 'deterministic',
  description: 'The output contains none of the forbidden strings.',
  argsSchema: z.strictObject({ value: stringOrList, case_sensitive: z.boolean().default(false) }),
  evaluate({ output, args }): EvaluatorOutcome {
    const forbidden = Array.isArray(args.value) ? args.value : [args.value];
    const haystack = args.case_sensitive ? asText(output) : asText(output).toLowerCase();
    const found = forbidden.filter((n) =>
      haystack.includes(args.case_sensitive ? n : n.toLowerCase()),
    );
    return {
      score: found.length === 0 ? 1 : 0,
      reason:
        found.length === 0
          ? 'No forbidden strings found.'
          : `Found forbidden: ${found.map((f) => `"${preview(f, 60)}"`).join(', ')}.`,
      metadata: { found },
    };
  },
});

export const regex = defineEvaluator({
  type: 'regex',
  kind: 'deterministic',
  description:
    'The output matches (or, with should_match: false, does not match) a regular expression.',
  argsSchema: z
    .strictObject({
      pattern: z.string().min(1),
      flags: z
        .string()
        .regex(/^[dgimsuy]*$/, 'flags may only contain d, g, i, m, s, u, y')
        .default(''),
      should_match: z.boolean().default(true),
    })
    .refine(
      (a) => {
        try {
          new RegExp(a.pattern, a.flags);
          return true;
        } catch {
          return false;
        }
      },
      { error: 'pattern is not a valid regular expression' },
    ),
  evaluate({ output, args }): EvaluatorOutcome {
    const match = new RegExp(args.pattern, args.flags).exec(asText(output));
    const passed = args.should_match ? match !== null : match === null;
    return {
      score: passed ? 1 : 0,
      reason: args.should_match
        ? match
          ? `Matched "${preview(match[0], 60)}".`
          : `No match for /${args.pattern}/${args.flags}.`
        : match
          ? `Unexpected match "${preview(match[0], 60)}".`
          : 'No match, as required.',
      metadata: match ? { match: match[0] } : {},
    };
  },
});

/**
 * Parses JSON from an output. Structured values are used as-is; model outputs (`{ text, json }`)
 * use their parsed `json` when present, otherwise their text; text may be wrapped in a Markdown
 * code fence.
 */
export function parseJsonOutput(
  value: JsonValue,
): { ok: true; value: JsonValue } | { ok: false; error: string } {
  if (Array.isArray(value)) return { ok: true, value };
  if (isJsonObject(value)) {
    if (value.json !== undefined && value.json !== null) return { ok: true, value: value.json };
    if (typeof value.text !== 'string') return { ok: true, value };
  }
  const text = asText(value).trim();
  const fenced = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i.exec(text);
  const candidate = fenced ? (fenced[1] as string) : text;
  try {
    return { ok: true, value: JSON.parse(candidate) as JsonValue };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });

function formatAjvErrors(errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).slice(0, 10).map((e) => {
    const where = e.instancePath || '(root)';
    if (e.keyword === 'additionalProperties') {
      return `${where}: unexpected property "${(e.params as { additionalProperty: string }).additionalProperty}"`;
    }
    return `${where}: ${e.message ?? 'is invalid'}`;
  });
}

export const json = defineEvaluator({
  type: 'json',
  kind: 'deterministic',
  description: 'The output is valid JSON and, when a schema is given, satisfies the JSON Schema.',
  argsSchema: z.strictObject({ schema: z.record(z.string(), z.json()).optional() }),
  evaluate({ output, args }): EvaluatorOutcome {
    const parsed = parseJsonOutput(output);
    if (!parsed.ok) {
      return {
        score: 0,
        reason: `Output is not valid JSON: ${parsed.error}.`,
        metadata: { errors: [parsed.error] },
      };
    }
    if (!args.schema) return { score: 1, reason: 'Output is valid JSON.' };
    let validate: ReturnType<typeof ajv.compile>;
    try {
      validate = ajv.compile(args.schema);
    } catch (error) {
      throw new Error(`The JSON Schema is invalid: ${(error as Error).message}`);
    }
    const ok = validate(parsed.value) as boolean;
    const errors = formatAjvErrors(validate.errors);
    return {
      score: ok ? 1 : 0,
      reason: ok
        ? 'Output is valid JSON and matches the schema.'
        : `Schema violations: ${errors.slice(0, 3).join('; ')}${errors.length > 3 ? '; …' : ''}.`,
      metadata: ok ? {} : { errors },
    };
  },
});

export const latency = defineEvaluator({
  type: 'latency',
  kind: 'deterministic',
  description: 'The workflow finished within a time budget (trace duration, excluding evaluation).',
  argsSchema: z.strictObject({ max_ms: z.number().positive() }),
  evaluate({ trace, args }): EvaluatorOutcome {
    const passed = trace.durationMs <= args.max_ms;
    return {
      score: passed ? 1 : 0,
      reason: `${formatDuration(trace.durationMs)} ${passed ? '≤' : '>'} ${formatDuration(args.max_ms)} budget.`,
      metadata: { duration_ms: trace.durationMs, max_ms: args.max_ms },
    };
  },
});

export const tokens = defineEvaluator({
  type: 'tokens',
  kind: 'deterministic',
  description: 'Token usage stayed within budget (total, input and/or output).',
  argsSchema: z
    .strictObject({
      max_total: z.number().int().positive().optional(),
      max_input: z.number().int().positive().optional(),
      max_output: z.number().int().positive().optional(),
    })
    .refine(
      (a) => a.max_total !== undefined || a.max_input !== undefined || a.max_output !== undefined,
      {
        error: 'set at least one of max_total, max_input or max_output',
      },
    ),
  evaluate({ trace, args }): EvaluatorOutcome {
    const checks: Array<[string, number, number | undefined]> = [
      ['total', trace.usage.totalTokens, args.max_total],
      ['input', trace.usage.inputTokens, args.max_input],
      ['output', trace.usage.outputTokens, args.max_output],
    ];
    const over = checks.filter(([, actual, limit]) => limit !== undefined && actual > limit);
    const estimated = trace.usage.estimated ? ' (estimated counts)' : '';
    return {
      score: over.length === 0 ? 1 : 0,
      reason:
        over.length === 0
          ? `Within token budget${estimated}.`
          : `${over.map(([name, actual, limit]) => `${name} ${actual} > ${limit}`).join(', ')}${estimated}.`,
      metadata: {
        input: trace.usage.inputTokens,
        output: trace.usage.outputTokens,
        total: trace.usage.totalTokens,
      },
    };
  },
});

export const cost = defineEvaluator({
  type: 'cost',
  kind: 'deterministic',
  description: 'Estimated cost stayed within budget.',
  argsSchema: z.strictObject({ max_usd: z.number().min(0) }),
  evaluate({ trace, args }): EvaluatorOutcome {
    if (trace.costUsd === null) {
      return {
        score: null,
        skipped: true,
        reason:
          'Cost is unknown because a model has no price. Add it under pricing: in scope.yaml.',
      };
    }
    const passed = trace.costUsd <= args.max_usd;
    return {
      score: passed ? 1 : 0,
      reason: `${formatUsd(trace.costUsd)} ${passed ? '≤' : '>'} ${formatUsd(args.max_usd)} budget (estimated).`,
      metadata: { cost_usd: trace.costUsd, max_usd: args.max_usd },
    };
  },
});
