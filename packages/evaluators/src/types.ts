/**
 * The evaluator contract (docs/decisions/0005).
 *
 * An evaluator scores one output. It declares its kind honestly — `deterministic` (a
 * verifiable rule), `heuristic` (a deterministic approximation of a fuzzy property) or `model`
 * (a model's judgment) — and always explains its result.
 */
import type { EvaluatorKind, JsonObject, JsonValue, Usage } from '@scope-ai/core';
import type { CompletionRequest, CompletionResponse, EmbeddingResponse } from '@scope-ai/providers';
import type { z } from 'zod';

export interface EvaluatorInput<Args> {
  /** The case inputs. */
  input: JsonValue;
  /** The output being judged (the workflow output, or what `with.output` selects). */
  output: JsonValue;
  /** The case's expected value, or what `with.expected` selects. */
  expected: JsonValue | null;
  /** Reference text such as retrieved documents (defaults to the trace's retrieval output). */
  context: string | null;
  /** Measurements of the traced execution. */
  trace: { durationMs: number; usage: Usage; costUsd: number | null };
  /** Evaluator-specific arguments, validated against `argsSchema`. */
  args: Args;
}

/** Model access for model-based evaluators. Calls are traced as child spans. */
export interface EvaluatorModels {
  complete(
    modelRef: string,
    request: Omit<CompletionRequest, 'model'>,
  ): Promise<CompletionResponse>;
  embed(modelRef: string, input: string[]): Promise<EmbeddingResponse>;
}

export interface EvaluatorContext {
  signal: AbortSignal;
  models: EvaluatorModels;
}

export interface EvaluatorOutcome {
  /** Normalized score in [0, 1], or null when a score does not apply. */
  score: number | null;
  /** Explicit verdict. When omitted, the framework compares `score` with the threshold. */
  passed?: boolean;
  /** Human-readable explanation. Always required: a score without a reason is not evidence. */
  reason: string;
  /** Machine-readable evidence (missing terms, unsupported sentences, judge output, …). */
  metadata?: JsonObject;
  /** The evaluator could not apply to this case (e.g. no expected value). */
  skipped?: boolean;
}

export type EvaluatorRequirement = 'expected' | 'context' | 'model';

export interface EvaluatorDefinition<Args = Record<string, unknown>> {
  type: string;
  kind: EvaluatorKind;
  /** One sentence: what this measures and how. */
  description: string;
  argsSchema: z.ZodType<Args>;
  /** Pass threshold for score-based verdicts when the workflow does not set one. */
  defaultThreshold?: number;
  requires?: readonly EvaluatorRequirement[];
  evaluate(
    input: EvaluatorInput<Args>,
    ctx: EvaluatorContext,
  ): Promise<EvaluatorOutcome> | EvaluatorOutcome;
}

/** Identity helper that gives custom evaluators full type inference. */
export function defineEvaluator<Args>(
  definition: EvaluatorDefinition<Args>,
): EvaluatorDefinition<Args> {
  return definition;
}

/** Arguments every evaluator accepts to choose what it judges; resolved by the engine. */
export const RESERVED_ARGS = ['output', 'expected', 'context', 'input'] as const;
