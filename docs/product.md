# SCOPE — Product

> See what your AI actually does.

SCOPE is an open-source, local-first platform for tracing, evaluating and regression-testing
AI workflows. It runs on a laptop with no account and no network access, and it runs in CI
where it fails a pull request when quality drops below a threshold the team chose.

This document defines what SCOPE is, who it is for, the vocabulary it uses, and what the
first release does and does not include. The technical design lives in
[architecture.md](./architecture.md); individual decisions live in [decisions/](./decisions/).

---

## 1. The problem

Teams shipping LLM features share three recurring failures:

1. **Opacity.** A user reports a bad answer. Nobody can say what was retrieved, what prompt
   was actually sent, which model answered, or how long each step took.
2. **Unmeasured change.** A prompt tweak, a model swap or a retrieval change ships because it
   "looked better" on three hand-picked examples. Quality regressions are found by users.
3. **Vendor lock-in for basic visibility.** The tools that solve (1) and (2) are mostly hosted
   services. Sending production prompts — which often contain customer data — to a third party
   is a non-starter for many teams.

SCOPE addresses all three with one data model: every execution is a **trace**, every trace can
be **evaluated**, and every batch of evaluated traces is a **run** that can be **compared**
against another run or against a committed **baseline**.

## 2. Users

| User | What they need from SCOPE |
| --- | --- |
| AI engineer building RAG systems, agents, LLM features | See each step of an execution; measure quality over a dataset; compare prompt/model variants |
| Backend engineer integrating an LLM API | Latency, token and cost visibility; errors with full context |
| ML engineer | Repeatable evaluation over datasets; score distributions; variant comparison |
| QA / test engineer | Deterministic assertions; regression detection in CI; readable reports |
| Open-source developer | A tool that works fully offline with no account and no telemetry |

## 3. Core journey

```text
install CLI ──▶ scope init ──▶ scope run ──▶ traces + evaluations stored locally
                                   │
          scope ui ◀───────────────┘
             │
             ├─ Overview: how is the system doing?
             ├─ Trace: what exactly happened in this execution?
             ├─ Run: which cases failed which evaluators?
             └─ Compare: did variant B beat variant A?
                                   │
    scope baseline save ◀──────────┘
             │
    GitHub Action: run + compare to baseline on every PR, fail on regression
```

Every feature in the first release exists to serve a step in this journey.

## 4. Vocabulary

SCOPE uses a small, fixed vocabulary. The same word means the same thing in the CLI, the API,
the dashboard and the docs.

| Term | Definition |
| --- | --- |
| **Project** | The unit of isolation. A directory with a `scope.yaml`, and the scope of an API key on a server. |
| **Workflow** | A named, versioned YAML definition of steps (retrieve, call a model, run a function, transform) plus the evaluators and gates that judge its output. |
| **Step** | One unit of a workflow. Each step becomes a span when executed. |
| **Dataset** | A list of **cases**. Each case has `inputs`, optional `expected` values and metadata. |
| **Run** | One execution of a workflow over a dataset (or a single input). A run owns its traces and has a summary: pass rate, latency, tokens, cost, per-evaluator scores. |
| **Variant** | A named set of parameter overrides for a workflow (for example a different model or prompt). Running a variant produces a run labelled with that variant. |
| **Trace** | One execution of a workflow for one case, or one operation instrumented with the SDK. A tree of spans. |
| **Span** | A timed operation inside a trace: a step, a model call, a retrieval, a tool call or an evaluator. |
| **Evaluator** | A function that scores an output. Every evaluator declares its **kind**: `deterministic`, `heuristic` or `model`. |
| **Evaluation** | The result of one evaluator on one trace: score (0–1), pass/fail, reason, metadata. |
| **Gate** | A threshold on a run metric (`pass_rate >= 0.9`, `latency.p95_ms <= 3000`, `evaluator.grounded.mean_score` may not drop by more than 0.05). Gates decide the exit code. |
| **Baseline** | A committed JSON snapshot of a run's summary and per-case results, used as the reference point for regression gates in CI. |
| **Comparison** | Side-by-side metrics and per-case changes between two runs, or a run and a baseline. |

"Experiment" is deliberately **not** a separate entity. Comparing prompt or model choices is
done by running variants and comparing the resulting runs. One concept, one name.

## 5. Principles

1. **Developer first.** Everything is usable from the terminal and readable without a demo.
2. **Open source first.** The complete product — engine, evaluators, storage, dashboard, CI
   integration — is Apache-2.0. There is no hosted-only feature in this release.
3. **Local first.** `scope run` and `scope ui` need nothing but Node.js. Data stays in
   `.scope/scope.db` unless the user points SCOPE at a server.
4. **GitHub native.** Baselines are committed files, so a quality change is reviewed in the
   same pull request as the code change that caused it.
5. **Observable by default.** Every workflow step, model call and evaluator is a span. No
   manual instrumentation is required for workflows run by SCOPE.
6. **Evidence over assumptions.** Every evaluator states whether it is deterministic,
   heuristic or model-based. Heuristic evaluators are signals, never verdicts, and the UI
   says so. Costs are labelled "estimated" and show which pricing table produced them.
7. **Extensible.** Step types, evaluators, model providers, storage backends and exporters are
   interfaces with registries. Custom evaluators and steps are plain JavaScript/TypeScript
   modules referenced by path.
8. **Excellent defaults.** Provider keys come from their standard environment variables,
   storage defaults to a local SQLite file, and a new project works offline immediately.
9. **Privacy by design.** Prompts and outputs may contain personal data. Secrets are redacted
   before storage, payload sizes are bounded, content capture can be disabled entirely, and
   SCOPE's own logs never contain prompt content.

## 6. First release (v0.1) scope

### In scope

| Area | Capability |
| --- | --- |
| Workflow config | Versioned YAML schema; strict validation with file/line/column errors and suggestions; JSON Schema for editor autocompletion; templating (`{{ inputs.question }}`); variants; datasets (JSONL, YAML, inline) |
| Engine | Step types `llm`, `retrieve`, `transform`, `function`; concurrency; per-step timeouts; retries with backoff for transient provider errors |
| Providers | OpenAI, Anthropic, any OpenAI-compatible endpoint (Ollama, vLLM, OpenRouter …), and `local`: offline deterministic models for demos and tests |
| Retrieval | Built-in BM25 retriever over local files (Markdown, text, JSONL) with chunking |
| Tracing | OpenTelemetry-aligned trace/span model; SDK for instrumenting existing TypeScript code; HTTP ingestion |
| Evaluators | Deterministic: exact match, contains, regex, JSON validity + JSON Schema, latency, tokens, cost. Heuristic: lexical similarity, groundedness, unsupported-claims (hallucination signal), relevance. Model-based: LLM judge (rubric), embedding similarity. Custom evaluators from files. |
| Runs & comparison | Run summaries, gates, per-case regression detection, variant comparison |
| Storage | SQLite (default, zero-config) and PostgreSQL (teams/self-hosting), shared migrations |
| CLI | `init`, `validate`, `run`, `evaluate`, `runs`, `traces`, `compare`, `report`, `baseline`, `ui`, `server`, `doctor`, `version`; JSON output everywhere |
| API | REST `/api/v1`: overview, runs, comparisons, traces, evaluations, workflows, models, ingestion; health, readiness, Prometheus metrics; API-key auth for server deployments |
| Dashboard | Overview, Runs (+ compare), Traces (+ trace explorer), Evaluations, Workflows, Models, Settings; command palette; keyboard navigation; light and dark themes |
| GitHub | Composite action: run, compare against baseline, write job summary, fail on gate violation |
| Distribution | Docker image and `docker compose up` demo (SCOPE + PostgreSQL), runnable examples |

### Explicitly out of scope for v0.1

These are real needs. They are listed on the [roadmap](./roadmap.md) and are not shown in the
product until they exist.

- User accounts, organizations, SSO, role-based access control (v0.1 servers use API keys)
- Python SDK (the ingestion API is language-neutral; a Python SDK is the first roadmap item)
- Automatic instrumentation of third-party SDKs (OpenAI/Anthropic client wrappers)
- OTLP ingestion endpoint (the data model is designed for it; the endpoint is not built)
- Hosted/cloud offering
- Human annotation and labelling queues
- Production sampling, alerting and online evaluation of live traffic
- Dataset management UI (datasets are files in the repository)

## 7. What success looks like for v0.1

A developer who has never heard of SCOPE can, in under five minutes and without an API key:

1. install the CLI and run `scope init`,
2. run the example workflow and read a useful terminal summary,
3. open the dashboard and understand a trace without documentation,
4. change a parameter, run a variant, and see exactly which cases got better or worse,
5. copy the GitHub Actions snippet and have regression gates on their next pull request.

## 8. Non-goals

- SCOPE is not an LLM framework. It does not compete with LangChain, LlamaIndex or the Vercel
  AI SDK; it observes and evaluates applications built with them.
- SCOPE is not a prompt IDE or playground.
- SCOPE does not claim that model-graded scores are ground truth. It reports them as model
  opinions, with the judge model and prompt recorded alongside the score.
