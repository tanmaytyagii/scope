/**
 * Tracing an existing application with @scope-ai/sdk.
 *
 * A small FAQ bot: search a few articles, answer, check the answer. Each question becomes a
 * trace sent to a SCOPE server (`scope ui` locally, or a shared `scope server`).
 *
 * With OPENAI_API_KEY set, answers come from OpenAI (OPENAI_MODEL, default gpt-5-mini) and the
 * model call is recorded with its tokens and estimated cost. Without it, the best matching
 * article is returned by a plain function, recorded as a function span — never presented as a
 * model call.
 */
import { createTracer, HttpExporter } from '@scope-ai/sdk';

const url = process.env.SCOPE_URL || 'http://127.0.0.1:4700';
const exporter = new HttpExporter({
  url,
  apiKey: process.env.SCOPE_API_KEY,
  project: process.env.SCOPE_PROJECT,
});
const tracer = createTracer({ exporter });

const ARTICLES = [
  { id: 'refunds', text: 'Refunds reach the original payment method within 5 to 7 business days.' },
  { id: 'shipping', text: 'Standard shipping takes 3 to 5 business days; orders over $50 ship free.' },
  { id: 'password', text: 'Reset your password with the Forgot password link on the sign-in page.' },
];

function search(question) {
  const words = new Set(question.toLowerCase().match(/[a-z]+/g) ?? []);
  return ARTICLES.map((a) => ({
    ...a,
    score: (a.text.toLowerCase().match(/[a-z]+/g) ?? []).filter((w) => words.has(w)).length,
  }))
    .filter((a) => a.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 2);
}

async function generate(question, context) {
  const model = process.env.OPENAI_MODEL || 'gpt-5-mini';
  return tracer.span('generate', { kind: 'llm', input: { model, question } }, async (span) => {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: 'Answer in one sentence using only the context.' },
          { role: 'user', content: `Context:\n${context}\n\nQuestion: ${question}` },
        ],
      }),
    });
    if (!response.ok) throw new Error(`OpenAI returned ${response.status}: ${await response.text()}`);
    const body = await response.json();
    // SCOPE's usage fields, mapped from the provider's names.
    span.recordModelCall({
      provider: 'openai',
      model,
      responseModel: body.model,
      finishReason: body.choices[0]?.finish_reason ?? null,
      usage: {
        inputTokens: body.usage?.prompt_tokens ?? 0,
        outputTokens: body.usage?.completion_tokens ?? 0,
      },
    });
    return body.choices[0]?.message?.content ?? '';
  });
}

async function ask(question) {
  return tracer.trace('faq-bot', { input: { question } }, async (trace) => {
    const hits = await tracer.span('search', { kind: 'retrieval', input: { question } }, () =>
      search(question),
    );
    const context = hits.map((h) => h.text).join('\n');
    const answer = process.env.OPENAI_API_KEY
      ? await generate(question, context)
      : await tracer.span('best-article', { kind: 'function' }, () =>
          hits[0]?.text ?? 'I could not find an answer to that.',
        );

    // Applications can record their own checks; they appear with the trace in SCOPE.
    const answered = hits.length > 0;
    trace.addEvaluation({
      evaluator: 'found_article',
      type: 'article_match',
      kind: 'deterministic',
      status: answered ? 'passed' : 'failed',
      score: answered ? 1 : 0,
      threshold: null,
      reason: answered ? `Matched ${hits.map((h) => h.id).join(', ')}.` : 'No article matched.',
      metadata: { articles: hits.map((h) => h.id) },
      durationMs: 0,
      spanId: null,
    });
    return answer;
  });
}

for (const question of [
  'How long do refunds take?',
  'Is shipping free?',
  'I forgot my password',
  'Do you sell gift wrapping?',
]) {
  console.log(`${question}\n  → ${await ask(question)}`);
}

await tracer.shutdown();
const { exportedTraces, droppedTraces } = exporter.stats;
if (droppedTraces > 0) {
  console.error(
    `\nCould not send ${droppedTraces} traces to ${url}. Start a server with \`scope ui\`, or set SCOPE_URL.`,
  );
  process.exitCode = 1;
} else {
  console.log(`\nSent ${exportedTraces} traces to ${url}. Open it and go to Traces.`);
}
