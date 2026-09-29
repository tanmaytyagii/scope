/**
 * A deterministic evaluator with an argument: the answer has at most `with.max` words.
 *
 * Arguments arrive as `args` (the workflow's `with:` values). Invalid arguments throw: SCOPE
 * records the evaluation as an error with this message, and the case as errored.
 */
export default {
  kind: 'deterministic',
  description: 'The answer has at most `max` words.',
  evaluate({ output, args }) {
    const max = args.max ?? 50;
    if (!Number.isInteger(max) || max < 1) throw new Error('with.max must be a positive integer');
    const text = typeof output === 'string' ? output : JSON.stringify(output ?? '');
    const words = text.split(/\s+/).filter(Boolean).length;
    return {
      score: words <= max ? 1 : 0,
      passed: words <= max,
      reason: `${words} words (limit ${max}).`,
      metadata: { words, max },
    };
  },
};
