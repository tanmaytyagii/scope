# Instrumenting an OpenAI SDK application

`app.mjs` is a small FAQ bot written against the official `openai` package. One line —
`instrumentOpenAI(new OpenAI(), { tracer })` — makes every model call a span in SCOPE, with its
prompt, response, tokens and, for priced models, estimated cost. The application code does not
change otherwise.

It needs an OpenAI-compatible endpoint: OpenAI itself, or a model on your machine.

```bash
# terminal 1: a local SCOPE server (any project works)
npm run scope -- ui --cwd examples/rag

# terminal 2, from the repository root: with OpenAI
OPENAI_API_KEY=sk-… node --conditions=scope-source examples/instrument-openai/app.mjs

# … or with a local model through Ollama's OpenAI-compatible API (nothing leaves your machine)
ollama pull deepseek-r1:1.5b
OPENAI_BASE_URL=http://127.0.0.1:11434/v1 OPENAI_API_KEY=ollama \
  OPENAI_MODEL=deepseek-r1:1.5b SCOPE_PROVIDER=ollama \
  node --conditions=scope-source examples/instrument-openai/app.mjs
```

(`--conditions=scope-source` runs SCOPE from its sources in this repository; in your own project,
`npm install @scope-ai/sdk openai` and run `node app.mjs`.)

| Variable | Default | Purpose |
| --- | --- | --- |
| `SCOPE_URL` | `http://127.0.0.1:4700` | SCOPE server to send traces to |
| `OPENAI_BASE_URL`, `OPENAI_API_KEY` | OpenAI | The endpoint and its key (the OpenAI SDK reads them) |
| `OPENAI_MODEL` | `gpt-5-mini` | Model to call |
| `SCOPE_PROVIDER` | `openai` | Provider name recorded on model calls |

SCOPE's pricing table covers OpenAI and Anthropic models; calls to a local model show their cost
as unknown (add a price under `pricing:` in `scope.yaml`, e.g. `input: 0, output: 0`).
