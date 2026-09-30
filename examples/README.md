# Examples

Each example runs offline — no API key — and produces real traces, evaluations and runs you can
open in the dashboard. Run them from the repository root after `npm ci && npm run build`
(or with an installed `scope` command, from the example's directory).

| Example | Shows |
| --- | --- |
| [rag](./rag) | Retrieval-augmented support answers: `retrieve` + `llm` steps, heuristic and deterministic evaluators, gates, variants, and a committed baseline that catches a regression |
| [triage](./triage) | Application code as a `function` step: traced tool calls, retrieval and model calls, structured output checked by JSON Schema and per-field evaluators |
| [custom-evaluator](./custom-evaluator) | Two evaluators written for the project — a deterministic one with arguments and a heuristic one with a threshold — gating a workflow |
| [sdk-tracing](./sdk-tracing) | Instrumenting an existing app with `@scope-ai/sdk` and sending traces to `scope ui` |
| [instrument-openai](./instrument-openai) | An application using the OpenAI SDK, traced with one line (`instrumentOpenAI`) — against OpenAI or a local model through Ollama; needs a model endpoint |
| [deploy](../deploy) | Not an example project but a production-style deployment: `scope server` on PostgreSQL with HTTPS, run in CI ([operations guide](../docs/guides/operations.md)) |

By what you want to see:

| You want | Look at |
| --- | --- |
| A basic application, traced | [sdk-tracing](./sdk-tracing), [instrument-openai](./instrument-openai) |
| Retrieval-augmented generation | [rag](./rag) |
| Structured output checked by a schema | [triage](./triage) |
| An agent-style workflow: your own code calling tools, retrieval and a model | [triage](./triage) |
| A regression caught in CI | [rag](./rag) (its terse variant against the committed baseline) |
| Your own evaluator | [custom-evaluator](./custom-evaluator) |
| A local model | [instrument-openai](./instrument-openai) with Ollama |
| A deployment for a team | [deploy](../deploy) |

Every example runs in CI (`examples/examples.test.ts`) with the commands its README shows.

The workflow examples use `local:extractive`, a deterministic offline stand-in that answers with
the context sentences that best match the question. It is not a language model; change
`params.model` to a real model (for example `anthropic:claude-sonnet-5` or `openai:gpt-5`, with
the provider's API key in the environment) to evaluate one.
