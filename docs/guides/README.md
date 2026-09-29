# SCOPE guides

Ordered by what you are trying to do. Most people start with the quickstart, then either test a
workflow or trace an application, then put it in CI.

## Start

| Guide | Read it to |
| --- | --- |
| [Quickstart](./quickstart.md) | Install SCOPE, run a workflow offline, and open the dashboard in five minutes |

## Test prompts, models and pipelines

| Guide | Read it to |
| --- | --- |
| [Workflows](./workflows.md) | Write workflows: steps, templates, datasets, outputs, variants and gates |
| [Evaluators](./evaluators.md) | Choose and configure evaluators, understand how each can be wrong |
| [Custom evaluators](./custom-evaluators.md) | Write your own: the module, its inputs and result, failures and versions |

## Trace an application you already have

| Guide | Read it to |
| --- | --- |
| [Tracing applications](./tracing.md) | Record model calls with one line around the OpenAI or Anthropic client, trace requests with the SDK, send OpenTelemetry spans, and turn traces into test cases |
| [Integrations](../integrations.md) | Find the path for your stack (SDKs, frameworks, OpenTelemetry, local models) and how well each is tested |

## Catch regressions before they merge

| Guide | Read it to |
| --- | --- |
| [CI and regressions](./ci.md) | Commit baselines and fail pull requests that lower quality — on GitHub, GitLab, Jenkins, CircleCI or Azure Pipelines |

## Run it for a team

| Guide | Read it to |
| --- | --- |
| [Self-hosting](./self-hosting.md) | Run a shared server with PostgreSQL, API keys and Docker |
| [Privacy and data](./privacy.md) | Know what is stored, what leaves your machine, what is redacted, and how to keep content out |

## Reference

| Guide | Read it to |
| --- | --- |
| [Configuration](./configuration.md) | Set up `scope.yaml`: storage, providers, pricing, privacy and defaults |
| [CLI reference](./cli.md) | Every command, its flags and exit codes |
| [HTTP API](./api.md) | Read runs, traces and evaluations over HTTP; ingest traces from other languages |
| [Extensibility](../extensibility.md) | Every extension point — evaluators, steps, providers, exporters, APIs — and its stability |

Background: [product](../product.md) · [architecture](../architecture.md) ·
[design decisions](../decisions/) · [performance](../performance.md) · [roadmap](../roadmap.md).
