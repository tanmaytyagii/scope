/**
 * An application that uses the OpenAI SDK, traced by SCOPE with one line: instrumentOpenAI.
 *
 * Works with OpenAI and with any OpenAI-compatible server — Ollama, vLLM, LM Studio, OpenRouter,
 * Gemini's OpenAI endpoint — through OPENAI_BASE_URL. Each question becomes a trace: a retrieval
 * span for the search, and the model call recorded automatically with its prompt, response,
 * tokens and (for priced models) estimated cost.
 */
import { createTracer, instrumentOpenAI } from '@scope-ai/sdk';
import OpenAI from 'openai';

const tracer = createTracer(); // sends to SCOPE_URL (default http://127.0.0.1:4700)
const openai = instrumentOpenAI(new OpenAI(), {
  tracer,
  // The name recorded on model calls; SCOPE prices OpenAI's models, not a local server's.
  provider: process.env.SCOPE_PROVIDER || 'openai',
});
const model = process.env.OPENAI_MODEL || 'gpt-5-mini';

const ARTICLES = [
  'Refunds reach the original payment method within 5 to 7 business days.',
  'Standard shipping takes 3 to 5 business days; orders over $50 ship free.',
  'Reset your password with the Forgot password link on the sign-in page.',
];

function search(question) {
  const words = new Set(question.toLowerCase().match(/[a-z]+/g) ?? []);
  return ARTICLES.filter((a) => (a.toLowerCase().match(/[a-z]+/g) ?? []).some((w) => words.has(w)));
}

async function ask(question) {
  return tracer.trace('faq-bot', { input: { question } }, async () => {
    const context = await tracer.span('search', { kind: 'retrieval', input: { question } }, () =>
      search(question).join('\n'),
    );
    // No SCOPE code here: the instrumented client records the call.
    const completion = await openai.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: 'Answer in one sentence using only the context.' },
        { role: 'user', content: `Context:\n${context}\n\nQuestion: ${question}` },
      ],
    });
    return completion.choices[0]?.message?.content ?? '';
  });
}

for (const question of ['How long do refunds take?', 'Is shipping free?']) {
  console.log(`${question}\n  → ${(await ask(question)).trim()}`);
}
await tracer.shutdown();
console.log(`Sent 2 traces to ${process.env.SCOPE_URL || 'http://127.0.0.1:4700'}.`);
