/**
 * Deterministic offline models (docs/decisions/0007). These are not language models.
 *
 * - `local:extractive` answers with the sentences from its prompt that best match the prompt's
 *   final line (the question): most question terms covered first, then BM25 score. Given retrieved context it produces grounded,
 *   sometimes incomplete answers — enough to exercise every evaluator meaningfully.
 * - `local:echo` returns the last user message.
 *
 * Options (`provider_options`): `sentences` (extractive, default 2), `delay_ms` (a fixed delay,
 * for testing timeouts; recorded on the span).
 */
import {
  createBm25Index,
  ErrorCodes,
  estimateTokens,
  ScopeError,
  sentences as splitSentences,
} from '@scope-ai/core';
import type {
  CallOptions,
  ChatMessage,
  CompletionRequest,
  CompletionResponse,
  ModelProvider,
} from './types.ts';

export const LOCAL_MODELS = ['extractive', 'echo'] as const;

export const NO_ANSWER = 'I could not find the answer in the provided context.';

const QUESTION_LABEL = /^\s*(?:question|q|query|user question)\s*:\s*/i;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function lastUserMessage(messages: readonly ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as ChatMessage;
    if (m.role === 'user') return m.content;
  }
  return '';
}

/** The question: the last line of the last user message that has content words. */
export function findQuestion(messages: readonly ChatMessage[]): string {
  const lines = lastUserMessage(messages)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = (lines[i] as string).replace(QUESTION_LABEL, '').trim();
    if (line && !/:\s*$/.test(line) && /[\p{L}\p{N}]/u.test(line)) return line;
  }
  return '';
}

export function extractiveAnswer(messages: readonly ChatMessage[], maxSentences: number): string {
  const question = findQuestion(messages);
  if (!question) return NO_ANSWER;
  const candidates: string[] = [];
  const seen = new Set<string>();
  for (const message of messages) {
    for (const line of message.content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || QUESTION_LABEL.test(trimmed)) continue;
      if (trimmed.replace(QUESTION_LABEL, '') === question) continue;
      for (const sentence of splitSentences(trimmed)) {
        if (sentence === question || seen.has(sentence)) continue;
        seen.add(sentence);
        candidates.push(sentence);
      }
    }
  }
  // Rank by how many distinct question terms a sentence covers, then by BM25. Plain BM25 favours
  // short sentences that match common terms; coverage first reads more like an answer.
  const hits = createBm25Index(candidates)
    .search(question, 50)
    .sort((a, b) => b.matched.length - a.matched.length || b.score - a.score || a.index - b.index);
  const top = hits[0];
  if (!top) return NO_ANSWER;
  // Add further sentences only when they are reasonably relevant and cover question terms the
  // answer does not cover yet (a simple form of maximal marginal relevance).
  const chosen = [top];
  const covered = new Set(top.matched);
  for (const hit of hits.slice(1)) {
    if (chosen.length >= Math.max(1, maxSentences)) break;
    if (hit.score < top.score * 0.35) continue;
    if (hit.matched.some((t) => !covered.has(t))) {
      chosen.push(hit);
      for (const t of hit.matched) covered.add(t);
    }
  }
  return chosen
    .sort((a, b) => a.index - b.index)
    .map((h) => candidates[h.index])
    .join(' ');
}

export function createLocalProvider(name = 'local'): ModelProvider {
  return {
    name,
    type: 'local',
    unsupportedParams: () => ['temperature', 'max_tokens'],
    async complete(
      request: CompletionRequest,
      options: CallOptions = {},
    ): Promise<CompletionResponse> {
      const opts = request.providerOptions ?? {};
      const delay = typeof opts.delay_ms === 'number' ? opts.delay_ms : 0;
      if (delay > 0) await sleep(delay, options.signal);

      let text: string;
      switch (request.model) {
        case 'echo':
          text = lastUserMessage(request.messages);
          break;
        case 'extractive': {
          const n =
            typeof opts.sentences === 'number' && opts.sentences > 0
              ? Math.floor(opts.sentences)
              : 2;
          text = extractiveAnswer(request.messages, n);
          break;
        }
        default:
          throw new ScopeError(
            ErrorCodes.providerModelNotFound,
            `The local provider has no model "${request.model}"`,
            {
              hint: `Local models: ${LOCAL_MODELS.map((m) => `local:${m}`).join(', ')}.`,
            },
          );
      }
      if (request.responseFormat === 'json') text = JSON.stringify({ answer: text });

      const inputTokens = estimateTokens(request.messages.map((m) => m.content).join('\n'));
      const outputTokens = estimateTokens(text);
      const ignoredParams: string[] = [];
      if (request.temperature !== undefined) ignoredParams.push('temperature');
      if (request.maxTokens !== undefined) ignoredParams.push('max_tokens');
      const attributes: Record<string, string | number | boolean> = {};
      if (delay > 0) attributes['scope.local.simulated_delay_ms'] = delay;
      return {
        text,
        model: request.model,
        finishReason: 'stop',
        rawFinishReason: 'stop',
        usage: {
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
          estimated: true,
        },
        ignoredParams,
        requestId: null,
        attributes,
      };
    },
  };
}
