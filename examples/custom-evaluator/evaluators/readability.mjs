/**
 * A heuristic evaluator with a threshold: Flesch reading ease of the answer.
 *
 * Heuristic, not deterministic: syllables are estimated from vowel groups, and the formula was
 * made for English prose, not lists or code. The score is reading ease / 100, clamped to 0–1;
 * the workflow's `threshold` decides pass or fail.
 */
function syllables(word) {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (w.length <= 3) return w ? 1 : 0;
  const groups = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '').match(/[aeiouy]{1,2}/g);
  return Math.max(1, groups ? groups.length : 1);
}

export default {
  kind: 'heuristic',
  description: 'Flesch reading ease of the answer, as a 0–1 score (higher is easier to read).',
  defaultThreshold: 0.5,
  evaluate({ output }) {
    const text = typeof output === 'string' ? output : '';
    const sentences = text.split(/[.!?]+/).filter((s) => s.trim()).length;
    const words = text.split(/\s+/).filter((w) => /[a-z]/i.test(w));
    if (sentences === 0 || words.length === 0)
      return { score: null, skipped: true, reason: 'No prose to measure.' };
    const syllableCount = words.reduce((n, w) => n + syllables(w), 0);
    const ease =
      206.835 - 1.015 * (words.length / sentences) - 84.6 * (syllableCount / words.length);
    const level = ease >= 60 ? 'plain English' : ease >= 30 ? 'fairly difficult' : 'difficult';
    return {
      score: Math.min(1, Math.max(0, ease / 100)),
      reason: `Flesch reading ease ${ease.toFixed(0)} (${level}); ${words.length} words in ${sentences} sentences.`,
      metadata: { readingEase: Math.round(ease * 10) / 10, words: words.length, sentences },
    };
  },
};
