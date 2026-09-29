# Extensibility

Where SCOPE can be extended without changing it, what each extension point promises, and what is
deliberately not pluggable. For getting traces in from existing stacks, see
[integrations](./integrations.md).

SCOPE has no plugin system. Each extension point is a module path in configuration, a small
TypeScript interface, or a data format with a published contract — whichever is the simplest
thing that works across the boundary it crosses.

## Extension points

| You want to | Use | Kind | Stability |
| --- | --- | --- | --- |
| Judge outputs your own way | [Custom evaluator](./guides/custom-evaluators.md): `type: ./evaluators/x.mjs` | module | Public contract |
| Run your own code as a workflow step | [`function` step](./guides/workflows.md): `module: ./app.mjs` | module | Public contract |
| Call a model behind any OpenAI-compatible API | [A named provider in `scope.yaml`](./guides/configuration.md#providers) | configuration | Public |
| Record traces from TypeScript | [`@scope-ai/sdk`](./guides/tracing.md): `Tracer`, spans, `recordModelCall` | library | Public API |
| Record OpenAI / Anthropic SDK calls | `instrumentOpenAI`, `instrumentAnthropic` | library | Public API |
| Send traces somewhere other than SCOPE | A `TraceExporter` (`export(bundle)`, optional `flush`/`shutdown`) passed to `new Tracer({ exporter })` | interface | Public API |
| Send traces from any language or framework | [OTLP/HTTP](./integrations.md#opentelemetry-otlphttp) to `/v1/traces`, or [`POST /api/v1/ingest`](./guides/api.md#ingestion) | protocol | OTLP spec; `scope-protocol: 1` |
| Read results from other tools | [HTTP API](./guides/api.md) (OpenAPI at `/api/v1/openapi.json`), `scope export`, JSON/JUnit/Markdown reports | protocol | `/api/v1` is versioned |
| Gate CI anywhere | `scope run` exit codes, `--junit-file`, `--report-file` | CLI | Documented exit codes |

"Public contract" means the shape is documented and changes follow the versioning policy in
[RELEASING.md](../RELEASING.md): additive within a minor version, breaking changes called out in
the CHANGELOG with the previous behavior kept for at least one minor version.

## Why these boundaries

- **Evaluators and function steps are modules, not plugins.** A workflow names the file; SCOPE
  imports it. There is nothing to register, discover or version separately: the module lives in
  the project, next to the workflow that uses it, and is reviewed like the rest of the code.
- **Frameworks integrate through OpenTelemetry, not adapters.** The Vercel AI SDK, OpenLLMetry
  and OpenInference already instrument LangChain, LlamaIndex and vendor SDKs in several languages.
  One well-mapped OTLP endpoint covers them all and follows their releases; a SCOPE adapter per
  framework would be shallower and fall behind. The two SDK wrappers exist for applications that
  use `@scope-ai/sdk` rather than an OpenTelemetry pipeline: one line records every call in
  SCOPE's own span model, without setting up exporters.
- **Providers extend by configuration.** Most model servers speak the OpenAI API; a named
  `openai-compatible` provider covers them with a base URL and a key. The `ModelProvider`
  interface in `@scope-ai/providers` is used internally for OpenAI, Anthropic and the offline
  models; it is not yet a public extension point, because no provider outside the OpenAI API
  shape has been asked for.

## Not extension points (yet)

| | Why |
| --- | --- |
| Storage backends | SQLite and PostgreSQL behind one Kysely implementation cover local and shared use; another database would be a new dialect in `@scope-ai/storage`, not a plugin |
| Dashboard pages | The dashboard reads the public API; build your own views on it rather than inside it |
| Step types beyond `llm`, `retrieve`, `transform`, `function` | `function` runs any code, traced; a new built-in step type is a contribution to `@scope-ai/engine` ([CONTRIBUTING](../CONTRIBUTING.md#adding-a-step-type)) |
| Built-in evaluators | New general-purpose evaluators are contributions to `@scope-ai/evaluators`; project-specific ones are custom evaluators |
| Server middleware | Put a reverse proxy in front of `scope server` for authentication, TLS or rate limits |
