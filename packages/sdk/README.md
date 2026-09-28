# @scope-ai/sdk

Trace any TypeScript or JavaScript application and send the traces to a
[SCOPE](https://github.com/tanmaytyagii/scope) server (`scope ui` locally, or `scope server`).

```bash
npm install @scope-ai/sdk
```

```ts
import { createTracer } from '@scope-ai/sdk';

const tracer = createTracer(); // exports to SCOPE_URL (default http://127.0.0.1:4700)

await tracer.trace('answer-question', { input: { question } }, async () => {
  const docs = await tracer.span('search', { kind: 'retrieval' }, () => search(question));
  return tracer.span('generate', { kind: 'llm' }, async (span) => {
    const res = await client.chat.completions.create({ model: 'gpt-5-mini', messages });
    span.recordModelCall({
      provider: 'openai',
      model: 'gpt-5-mini',
      usage: { inputTokens: res.usage.prompt_tokens, outputTokens: res.usage.completion_tokens },
    });
    return res.choices[0].message.content;
  });
});
```

Spans nest automatically across `await`; export is batched, bounded and never throws into your
application. Guide: [tracing applications](https://github.com/tanmaytyagii/scope/blob/main/docs/guides/tracing.md).

Apache-2.0.
