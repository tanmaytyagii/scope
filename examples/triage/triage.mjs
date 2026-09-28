/**
 * Ticket triage, as ordinary application code. Everything done through `ctx` is traced:
 * `ctx.tool` records a tool span, `ctx.retrieve` a retrieval span, `ctx.llm` a model-call span.
 */
import { readFile } from 'node:fs/promises';

const INTENTS = {
  refund: ['refund', 'money back', 'return', 'charged twice'],
  shipping: ['where is', 'shipping', 'delivery', 'arrive', 'tracking', 'late'],
  account: ['password', 'log in', 'login', 'account', 'email address'],
};

async function lookupOrder(id) {
  const orders = JSON.parse(await readFile(new URL('./data/orders.json', import.meta.url), 'utf8'));
  return orders[id] ?? null;
}

export async function triage(_args, ctx) {
  const message = String(ctx.inputs.message);
  const text = message.toLowerCase();
  const intent =
    Object.entries(INTENTS).find(([, words]) => words.some((w) => text.includes(w)))?.[0] ?? 'other';

  const order = ctx.inputs.order_id
    ? await ctx.tool('orders.lookup', { id: ctx.inputs.order_id }, () => lookupOrder(ctx.inputs.order_id))
    : null;

  const urgent =
    ctx.params.urgent_words.some((w) => text.includes(w)) || order?.status === 'lost';

  const policy = await ctx.retrieve({ query: message, corpus: '../policies/*.md', top_k: 2 });
  const reply = await ctx.llm({
    model: ctx.params.model,
    system: 'You are a support agent. Answer using only the policy text.',
    prompt: `Policy:\n${policy.text}\n\nQuestion: ${message}`,
  });

  return {
    intent,
    priority: urgent ? 'high' : 'normal',
    order_status: order?.status ?? null,
    reply: reply.text,
  };
}
