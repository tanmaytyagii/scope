# Tracing an existing application

`app.mjs` is a small FAQ bot instrumented with `@scope-ai/sdk`: a trace per question, a
retrieval span for the search, and the answer as a model-call span (with `OPENAI_API_KEY`) or a
function span (without). It also records its own check as an evaluation. Traces go to a SCOPE
server over HTTP.

```bash
# terminal 1: a local server (any SCOPE project works)
npm run scope -- ui --cwd examples/rag

# terminal 2, from the repository root (after npm run build)
node examples/sdk-tracing/app.mjs
# Sent 4 traces to http://127.0.0.1:4700. Open it and go to Traces.
```

Environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `SCOPE_URL` | `http://127.0.0.1:4700` | Server to send traces to |
| `SCOPE_API_KEY` | — | Key with the `ingest` scope, for a `scope server` |
| `SCOPE_PROJECT` | the served project | Project name, for servers without authentication |
| `OPENAI_API_KEY`, `OPENAI_MODEL` | — / `gpt-5-mini` | Answer with OpenAI instead of the offline function |

Model calls are recorded with `span.recordModelCall({ provider, model, usage: { inputTokens,
outputTokens } })`; SCOPE estimates the cost from its pricing table. If the server is
unreachable, the exporter retries, then drops the traces and the script says so — tracing never
breaks the application.
