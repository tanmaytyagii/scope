# SCOPE documentation

Organized by what you are doing. New to SCOPE? Start with the quickstart, then either evaluate a
workflow or instrument an application, then put it in CI.

## Getting started

| Guide | Read it to |
| --- | --- |
| [Quickstart](./quickstart.md) | Install SCOPE, run a workflow offline, and open the dashboard in five minutes |
| [Examples](../../examples/README.md) | See each part working: RAG, structured output, tool-calling code, custom evaluators, instrumented apps |

## Instrument and trace

| Guide | Read it to |
| --- | --- |
| [Tracing applications](./tracing.md) | Record model calls with one line around the OpenAI or Anthropic client, trace requests with the SDK, send OpenTelemetry spans, and turn traces into test cases |
| [Integrations](../integrations.md) | Find the path for your stack (SDKs, LangChain, Vercel AI SDK, OpenTelemetry, local models) and how each is tested |

## Evaluate and compare

| Guide | Read it to |
| --- | --- |
| [Workflows](./workflows.md) | Write workflows: steps, templates, datasets, variants, gates — and what a run records to be reproducible |
| [Evaluators](./evaluators.md) | Choose and configure evaluators, and understand how each can be wrong |
| [Custom evaluators](./custom-evaluators.md) | Write your own: the module, its inputs and result, failures and versions |

## CI

| Guide | Read it to |
| --- | --- |
| [CI and regressions](./ci.md) | Commit baselines and fail pull requests that lower quality — on GitHub, GitLab, Jenkins, CircleCI or Azure Pipelines |

## Deploy and operate

| Guide | Read it to |
| --- | --- |
| [Self-hosting](./self-hosting.md) | Run `scope server`: configuration, API keys, Docker |
| [Operations](./operations.md) | Deploy with Docker Compose and HTTPS, monitor, upgrade, back up, keep the database in bounds, rotate keys |
| [Performance](../performance.md) | Measured ingestion and query times up to large databases, and what they mean for deployments |

## Security and privacy

| Guide | Read it to |
| --- | --- |
| [Privacy and data](./privacy.md) | Know what is stored, what leaves your machine, what is redacted, and how to keep content out |
| [Security policy](../../SECURITY.md) | Report a vulnerability; what is in scope; known limitations |

## Reference

| Guide | Read it to |
| --- | --- |
| [Configuration](./configuration.md) | Set up `scope.yaml`: storage, providers, pricing, privacy and defaults |
| [CLI](./cli.md) | Every command, its flags and exit codes |
| [HTTP API](./api.md) | Read runs, traces and evaluations; ingest traces; which interfaces are stable |
| [SDK](./tracing.md) | `createTracer`, spans, instrumentation, exporters and delivery guarantees |
| [Extensibility](../extensibility.md) | Every extension point — evaluators, steps, providers, exporters, APIs — and its stability |

## Contribute

[Contributing](../../CONTRIBUTING.md) (setup, conventions, a guide per part of the code) ·
[architecture](../architecture.md) · [design decisions](../decisions/) ·
[design system](../design-system.md) · [roadmap](../roadmap.md) · [releasing](../../RELEASING.md)
