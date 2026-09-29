# Quickstart

In five minutes and without an API key: install SCOPE, run and evaluate a workflow, inspect a
trace in the dashboard, and catch a regression.

## 1. Install

SCOPE needs Node.js 22.16 or newer. It is not published to npm yet — from the first release on,
`npm install -g scope-ai` installs the `scope` command. Until then, install it from source:

```bash
git clone https://github.com/tanmaytyagii/scope.git
cd scope
npm ci
npm run build
npm link -w @scope-ai/cli      # puts `scope` on your PATH
scope --version
```

(Prefer not to link? Run `node /path/to/scope/packages/cli/dist/bin.js` wherever this guide says
`scope`.)

## 2. Create a project

```bash
scope init support-bot
cd support-bot
```

This creates a retrieval-augmented support workflow (`workflows/support.yaml`), a dataset of
twelve questions with the facts each answer must contain, the help-center documents it answers
from, and `scope.yaml`. It runs offline with `local:extractive`, a deterministic stand-in that
answers with the context sentences that best match the question — not a language model, but
enough to exercise every part of SCOPE.

## 3. Run it

```bash
scope run
```

`scope run` runs every workflow in the project — here, `workflows/support.yaml`; name one to run
only that (`scope run workflows/support.yaml`). Every case runs, every step is traced, every evaluator scores the output, and the gates decide
the exit code (0 passed, 1 gates failed). The summary shows pass rate, latency, tokens,
estimated cost and each evaluator's results; failing cases are listed with the reason.

## 4. Look inside

```bash
scope ui --open
```

The dashboard opens at <http://127.0.0.1:4700>. Open **Runs → #1**, filter the cases to
**Failed**, and click a case: the trace explorer shows the retrieval (which documents were
found, with scores), the model call (the exact prompt and response), and each evaluator's
verdict with its evidence.

From the terminal: `scope runs 1`, `scope traces --run 1 --eval failed`, `scope traces <id>`.

## 5. Catch a regression

Make run #1 the reference and commit it:

```bash
scope baseline save 1        # writes baselines/support.json
```

Now make answers worse — in `workflows/support.yaml`, change `sentences: 2` to `sentences: 1` —
and run again:

```bash
scope run workflows/support.yaml
# FAILED — Pass rate 83.3% → 75.0% (−8.3 pp); dropped more than the allowed 5.0 pp
scope compare 1 2            # which cases regressed, and which evaluator flipped
```

That comparison is what [CI](./ci.md) runs on every pull request.

## 6. Use a real model

Set `params.model` in the workflow to a model and export the provider's key:

```bash
export ANTHROPIC_API_KEY=…    # or OPENAI_API_KEY
# params.model: anthropic:claude-sonnet-5   (or openai:gpt-5)
scope run workflows/support.yaml
```

Costs are estimated from SCOPE's pricing table (see [configuration](./configuration.md#pricing)).
To compare models side by side, add them as [variants](./workflows.md#inputs-params-and-variants) and run
`scope run workflows/support.yaml --all-variants`.

## Next

- **Test your own prompts or pipeline**: [write a workflow](./workflows.md), pick
  [evaluators](./evaluators.md), or [write one](./custom-evaluators.md).
- **See what an application you already have does**: wrap its OpenAI or Anthropic client in one
  line, or point its OpenTelemetry exporter at SCOPE — [tracing](./tracing.md). Then turn what
  you observed into test cases with `scope export traces --format dataset`.
- **Stop regressions from merging**: [gate pull requests in CI](./ci.md).
- **Share it with a team**: [self-host a server](./self-hosting.md).

Every guide, by task: [guides](./README.md).
