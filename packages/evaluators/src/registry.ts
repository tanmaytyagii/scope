import { ErrorCodes, ScopeError, suggest } from '@scope-ai/core';
import {
  contains,
  cost,
  exactMatch,
  json,
  latency,
  notContains,
  regex,
  tokens,
} from './deterministic.ts';
import { groundedness, relevance, similarity, unsupportedClaims } from './heuristic.ts';
import { embeddingSimilarity, llmJudge } from './model.ts';
import type { EvaluatorDefinition } from './types.ts';

// biome-ignore lint/suspicious/noExplicitAny: definitions have heterogeneous argument types
type AnyEvaluator = EvaluatorDefinition<any>;

export const BUILTIN_EVALUATORS: readonly AnyEvaluator[] = [
  exactMatch,
  contains,
  notContains,
  regex,
  json,
  latency,
  tokens,
  cost,
  similarity,
  groundedness,
  unsupportedClaims,
  relevance,
  llmJudge,
  embeddingSimilarity,
];

export class EvaluatorRegistry {
  readonly #definitions = new Map<string, AnyEvaluator>();

  constructor(definitions: readonly AnyEvaluator[] = BUILTIN_EVALUATORS) {
    for (const d of definitions) this.register(d);
  }

  register(definition: AnyEvaluator): void {
    this.#definitions.set(definition.type, definition);
  }

  has(type: string): boolean {
    return this.#definitions.has(type);
  }

  get(type: string): AnyEvaluator {
    const definition = this.#definitions.get(type);
    if (!definition) {
      const guess = suggest(type, this.#definitions.keys());
      throw new ScopeError(ErrorCodes.configInvalid, `Unknown evaluator type "${type}"`, {
        hint: guess
          ? `Did you mean "${guess}"?`
          : `Built-in evaluators: ${[...this.#definitions.keys()].join(', ')}. Custom evaluators are referenced by file path, e.g. ./evaluators/policy.ts.`,
      });
    }
    return definition;
  }

  list(): AnyEvaluator[] {
    return [...this.#definitions.values()];
  }
}
