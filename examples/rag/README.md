# RAG support assistant

Answers customer questions from the help center in `docs/`: a BM25 `retrieve` step, then an
`llm` step. Every case is judged by four evaluators and the run is gated on pass rate and
groundedness. `baselines/support.json` was saved from a real run and is committed, so
regressions fail.

```bash
# from the repository root
npm run scope -- run workflows/support.yaml --cwd examples/rag
```

Try a regression: the `terse` variant answers with one sentence instead of two and drops facts
the dataset expects.

```bash
npm run scope -- run workflows/support.yaml --variant terse --baseline baselines/support.json --cwd examples/rag
#   Changed  sentences 2 → 1
# FAILED — Pass rate 83.3% → 75.0% (−8.3 pp); dropped more than the allowed 5.0 pp
```

Then look at what changed, case by case:

```bash
npm run scope -- compare 1 2 --cwd examples/rag
npm run scope -- ui --cwd examples/rag      # open the run, then a failing case's trace
```

| File | Purpose |
| --- | --- |
| `workflows/support.yaml` | Steps, variants, evaluators and gates |
| `datasets/support.jsonl` | Questions, each with the facts its answer must contain |
| `docs/*.md` | The help center the workflow retrieves from |
| `baselines/support.json` | The committed reference run for regression gates |
