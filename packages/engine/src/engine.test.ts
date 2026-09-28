import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDataset, parseWorkflow, prepareCases } from '@scope-ai/config';
import { summarizeRun, type TraceBundle } from '@scope-ai/core';
import { MemoryExporter } from '@scope-ai/sdk';
import { beforeAll, describe, expect, it } from 'vitest';
import { chunkText } from './corpus.ts';
import { Engine, toCaseResult } from './engine.ts';
import { globToRegExp } from './glob.ts';

const dir = mkdtempSync(join(tmpdir(), 'scope-engine-'));

const project = {
  root: dir,
  providers: {},
  pricing: {},
  privacy: {},
  defaults: { concurrency: 2, timeoutMs: null },
};

beforeAll(() => {
  mkdirSync(join(dir, 'docs'));
  writeFileSync(
    join(dir, 'docs', 'refunds.md'),
    [
      '# Refunds',
      '',
      'Refunds are issued to the original payment method.',
      'Refunds take 5 to 7 business days to appear on a card statement.',
      '',
      '# Gift cards',
      '',
      'Gift cards cannot be refunded or exchanged for cash.',
    ].join('\n'),
  );
  writeFileSync(
    join(dir, 'docs', 'shipping.md'),
    [
      '# Shipping',
      '',
      'Standard shipping takes 3 to 5 business days.',
      'Orders over $50 ship free within the United States.',
    ].join('\n'),
  );
  writeFileSync(
    join(dir, 'tools.mjs'),
    [
      'export async function lookup(args, ctx) {',
      '  const order = await ctx.tool("orders.get", { id: ctx.inputs.order_id }, () => {',
      '    if (ctx.inputs.order_id === "missing") throw new Error("order not found");',
      '    return { id: ctx.inputs.order_id, status: "shipped" };',
      '  });',
      '  const reply = await ctx.llm({ model: "local:echo", prompt: `Order ${order.id} is ${order.status}.` });',
      '  return { order, reply: reply.text, prefix: args.prefix };',
      '}',
      'export async function hang(args, ctx) {',
      '  await new Promise((resolve) => ctx.signal.addEventListener("abort", resolve));',
      '  return "stopped";',
      '}',
    ].join('\n'),
  );
  writeFileSync(
    join(dir, 'polite.mjs'),
    [
      'export default {',
      '  kind: "deterministic",',
      '  description: "Replies start with a greeting.",',
      '  evaluate({ output }) {',
      '    const ok = /^order/i.test(String(output));',
      '    return { score: ok ? 1 : 0, reason: ok ? "Starts with the order." : "Does not start with the order." };',
      '  },',
      '};',
    ].join('\n'),
  );
});

const RAG = `version: 1
name: support
inputs:
  question: { type: string }
params:
  model: local:extractive
  top_k: 2
variants:
  narrow:
    top_k: 1
steps:
  - id: retrieve
    type: retrieve
    with:
      query: "{{ inputs.question }}"
      corpus: docs/*.md
      top_k: "{{ params.top_k }}"
  - id: answer
    type: llm
    with:
      model: "{{ params.model }}"
      system: Answer using only the context.
      prompt: |
        Context:
        {{ steps.retrieve.output.text }}

        Question: {{ inputs.question }}
outputs:
  answer: "{{ steps.answer.output.text }}"
dataset:
  cases:
    - id: refund-time
      inputs: { question: How many days do refunds take? }
      expected: 5 to 7 business days
    - id: gift-cards
      inputs: { question: Can gift cards be refunded? }
      expected: cannot be refunded
    - id: free-shipping
      inputs: { question: Which orders ship free? }
      expected: over $50
evaluators:
  - name: grounded
    type: groundedness
  - name: facts
    type: contains
  - name: fast
    type: latency
    with: { max_ms: 5000 }
gates:
  - metric: pass_rate
    min: 0.5
`;

function load(text: string) {
  const loaded = parseWorkflow(text, {
    path: join(dir, 'wf.yaml'),
    displayPath: 'wf.yaml',
    env: {},
  });
  const dataset = loadDataset(loaded.definition.dataset ?? { cases: [{ inputs: {} }] }, {
    baseDir: dir,
    root: dir,
    workflowName: loaded.definition.name,
  });
  return { loaded, cases: prepareCases(dataset, loaded.definition.inputs).cases };
}

function setup() {
  const exporter = new MemoryExporter();
  const engine = new Engine({ project, exporter });
  return { exporter, engine };
}

function bundleFor(exporter: MemoryExporter, caseId: string): TraceBundle {
  const bundle = exporter.bundles.find((b) => b.trace.caseId === caseId);
  if (!bundle) throw new Error(`no trace for ${caseId}`);
  return bundle;
}

describe('Engine: retrieval-augmented workflow', () => {
  it('executes every case, traces each step and evaluates the output', async () => {
    const { exporter, engine } = setup();
    const { loaded, cases } = load(RAG);
    const prepared = await engine.prepare(loaded);
    const { executions, cancelled } = await engine.run(prepared, cases, { runId: 'run_test' });
    expect(cancelled).toBe(false);
    expect(executions.map((e) => [e.caseId, e.status])).toEqual([
      ['refund-time', 'ok'],
      ['gift-cards', 'ok'],
      ['free-shipping', 'ok'],
    ]);
    const refund = executions[0];
    expect(refund?.output).toBe('Refunds take 5 to 7 business days to appear on a card statement.');
    expect(refund?.evaluations.map((e) => [e.evaluator, e.kind, e.status])).toEqual([
      ['grounded', 'heuristic', 'passed'],
      ['facts', 'deterministic', 'passed'],
      ['fast', 'deterministic', 'passed'],
    ]);

    const bundle = bundleFor(exporter, 'refund-time');
    const names = bundle.spans.map((s) => `${s.kind}:${s.name}`);
    expect(names).toEqual([
      'workflow:support',
      'retrieval:retrieve',
      'llm:answer',
      'evaluation:evaluate',
      'evaluation:grounded',
      'evaluation:facts',
      'evaluation:fast',
    ]);
    const root = bundle.spans[0];
    const llm = bundle.spans.find((s) => s.kind === 'llm');
    expect(llm).toMatchObject({
      parentId: root?.id,
      provider: 'local',
      model: 'extractive',
      costUsd: 0,
    });
    expect(llm?.attributes).toMatchObject({
      'gen_ai.request.model': 'extractive',
      'scope.usage.estimated': true,
      'scope.step.id': 'answer',
    });
    expect((llm?.input as { messages: unknown[] } | undefined)?.messages).toHaveLength(2);
    const retrieval = bundle.spans.find((s) => s.kind === 'retrieval');
    expect(retrieval?.attributes).toMatchObject({
      'scope.retrieval.method': 'bm25',
      'scope.retrieval.returned': 2,
    });
    expect(
      (retrieval?.output as { documents: Array<{ source: string }> } | undefined)?.documents[0]
        ?.source,
    ).toBe('docs/refunds.md');
    const evaluate = bundle.spans.find((s) => s.name === 'evaluate');
    expect(evaluate?.parentId).toBeNull();
    expect(bundle.trace).toMatchObject({
      runId: 'run_test',
      caseId: 'refund-time',
      status: 'ok',
      output: { answer: refund?.output },
      metadata: { workflow: 'support', expected: '5 to 7 business days' },
    });
    expect(bundle.trace.durationMs).toBe(root?.durationMs);
    expect(
      bundle.evaluations.every((e) => e.traceId === bundle.trace.id && e.spanId !== null),
    ).toBe(true);

    const summary = summarizeRun(executions.map(toCaseResult), {
      evaluatorOrder: prepared.evaluators.map((e) => e.name),
    });
    expect(summary.cases.total).toBe(3);
    expect(summary.tokens.estimated).toBe(true);
    expect(summary.cost.totalUsd).toBe(0);
    expect(prepared.gates).toEqual([{ metric: 'pass_rate', min: 0.5 }]);
  });

  it('applies variant params', async () => {
    const { exporter, engine } = setup();
    const { loaded, cases } = load(RAG);
    const prepared = await engine.prepare(loaded, { variant: 'narrow' });
    expect(prepared.params).toEqual({ model: 'local:extractive', top_k: 1 });
    await engine.run(prepared, cases.slice(0, 1), { runId: null });
    const retrieval = exporter.bundles[0]?.spans.find((s) => s.kind === 'retrieval');
    expect(retrieval?.attributes['scope.retrieval.returned']).toBe(1);
    expect(exporter.bundles[0]?.trace.metadata.variant).toBe('narrow');
  });

  it('re-scores stored outputs without running steps', async () => {
    const { exporter, engine } = setup();
    const { loaded, cases } = load(RAG);
    const prepared = await engine.prepare(loaded);
    await engine.run(prepared, cases.slice(0, 1), { runId: null });
    const { trace } = exporter.bundles[0] as TraceBundle;
    const records = await engine.evaluateStored(prepared, {
      traceId: trace.id,
      runId: null,
      input: trace.input,
      output: trace.output,
      expected: 'something else entirely',
      context: 'Refunds take 5 to 7 business days to appear on a card statement.',
      durationMs: trace.durationMs,
      usage: trace.usage,
      costUsd: trace.costUsd,
    });
    expect(records.map((r) => [r.evaluator, r.status])).toEqual([
      ['grounded', 'passed'],
      ['facts', 'failed'],
      ['fast', 'passed'],
    ]);
    expect(exporter.bundles).toHaveLength(1);
  });
});

describe('Engine: failures, functions and limits', () => {
  const FUNCTIONS = `version: 1
name: orders
inputs:
  order_id: { type: string }
steps:
  - id: lookup
    type: function
    with:
      module: ./tools.mjs
      export: lookup
      args: { prefix: "Order" }
outputs:
  reply: "{{ steps.lookup.output.reply }}"
evaluators:
  - name: polite
    type: ./polite.mjs
dataset:
  cases:
    - id: ok
      inputs: { order_id: A-1 }
    - id: missing
      inputs: { order_id: missing }
`;

  it('traces tool and model calls made from function steps and runs custom evaluators', async () => {
    const { exporter, engine } = setup();
    const { loaded, cases } = load(FUNCTIONS);
    const prepared = await engine.prepare(loaded);
    expect(prepared.evaluators[0]).toMatchObject({ name: 'polite', custom: true });
    const { executions } = await engine.run(prepared, cases, { runId: null, concurrency: 1 });
    const [ok, missing] = executions;
    expect(ok).toMatchObject({ status: 'ok', output: 'Order A-1 is shipped.' });
    expect(ok?.evaluations[0]).toMatchObject({
      evaluator: 'polite',
      kind: 'deterministic',
      status: 'passed',
    });
    const spans = bundleFor(exporter, 'ok').spans;
    const fn = spans.find((s) => s.kind === 'function');
    expect(spans.filter((s) => s.parentId === fn?.id).map((s) => `${s.kind}:${s.name}`)).toEqual([
      'tool:orders.get',
      'llm:local:echo',
    ]);
    expect(spans.find((s) => s.kind === 'tool')?.output).toEqual({ id: 'A-1', status: 'shipped' });

    expect(missing).toMatchObject({ status: 'error', evaluations: [] });
    expect(missing?.error?.message).toBe('order not found');
    const failed = bundleFor(exporter, 'missing');
    expect(failed.spans.find((s) => s.kind === 'tool')?.status).toBe('error');
    expect(failed.spans.some((s) => s.kind === 'evaluation')).toBe(false);
  });

  it('continues past failing steps when continue_on_error is set', async () => {
    const { engine } = setup();
    const text = FUNCTIONS.replace(
      '      args: { prefix: "Order" }',
      '      args: { prefix: "Order" }\n    continue_on_error: true',
    ).replace('  reply: "{{ steps.lookup.output.reply }}"', '  reply: "{{ steps.lookup.status }}"');
    const { loaded, cases } = load(text);
    const { executions } = await engine.run(await engine.prepare(loaded), cases.slice(1), {
      runId: null,
    });
    expect(executions[0]).toMatchObject({ status: 'ok', output: 'error' });
  });

  it('enforces step timeouts and reports them clearly', async () => {
    const { exporter, engine } = setup();
    const text = `version: 1
name: slow
steps:
  - id: think
    type: llm
    timeout_ms: 50
    with:
      model: local:echo
      prompt: hello
      provider_options: { local: { delay_ms: 5000 } }
`;
    const { loaded, cases } = load(text);
    const started = Date.now();
    const { executions } = await engine.run(await engine.prepare(loaded), cases, { runId: null });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(executions[0]?.error).toMatchObject({
      code: 'step_timeout',
      message: 'Step "think" timed out after 50 ms',
    });
    expect(exporter.bundles[0]?.spans[1]?.status).toBe('error');
  });

  it('stops scheduling on cancellation and reports it', async () => {
    const { engine } = setup();
    const text = `version: 1
name: hang
steps:
  - id: wait
    type: function
    with: { module: ./tools.mjs, export: hang }
dataset:
  cases: [{ inputs: { n: 1 } }, { inputs: { n: 2 } }, { inputs: { n: 3 } }]
`;
    const { loaded, cases } = load(text);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);
    const result = await engine.run(await engine.prepare(loaded), cases, {
      runId: null,
      concurrency: 1,
      signal: controller.signal,
    });
    expect(result.cancelled).toBe(true);
    expect(result.executions).toHaveLength(1);
    expect(result.executions[0]?.error?.code).toBe('cancelled');
  });

  it('bails after the first case that does not pass', async () => {
    const { engine } = setup();
    const { loaded, cases } = load(
      FUNCTIONS.replace('    - id: ok\n      inputs: { order_id: A-1 }\n', '').replace(
        'dataset:\n  cases:\n',
        'dataset:\n  cases:\n    - id: first\n      inputs: { order_id: missing }\n    - id: second\n      inputs: { order_id: A-2 }\n',
      ),
    );
    const { executions } = await engine.run(await engine.prepare(loaded), cases, {
      runId: null,
      concurrency: 1,
      bail: true,
    });
    expect(executions.map((e) => e.caseId)).toEqual(['first']);
  });

  it('turns template errors at runtime into step errors with hints', async () => {
    const { engine } = setup();
    const text = RAG.replace(
      'query: "{{ inputs.question }}"',
      'query: "{{ case.metadata.topic }}"',
    );
    const { loaded, cases } = load(text);
    const { executions } = await engine.run(await engine.prepare(loaded), cases.slice(0, 1), {
      runId: null,
    });
    expect(executions[0]?.error?.message).toBe(
      '{{ case.metadata.topic }}: "topic" does not exist in case.metadata',
    );
  });
});

describe('Engine: validation', () => {
  function diagnostics(text: string) {
    const { engine } = setup();
    return engine.validate(
      parseWorkflow(text, { path: join(dir, 'wf.yaml'), displayPath: 'wf.yaml', env: {} }),
    );
  }

  it('checks step types, argument names and values', () => {
    const d = diagnostics(RAG.replace('type: retrieve', 'type: retreive'));
    expect(d[0]).toMatchObject({
      severity: 'error',
      message: 'unknown step type "retreive"',
      hint: 'Did you mean "retrieve"?',
      line: 13,
    });
    const badArg = diagnostics(RAG.replace('      top_k: "{{ params.top_k }}"', '      topk: 3'));
    expect(badArg[0]).toMatchObject({
      message: 'the retrieve step has no argument "topk"',
      hint: 'Did you mean "top_k"?',
    });
    const badValue = diagnostics(RAG.replace('model: local:extractive', 'model: gpt-5'));
    expect(badValue.map((x) => x.message)).toContain('"gpt-5" is not a model reference');
  });

  it('checks providers per variant, corpus files and modules', () => {
    const text = RAG.replace(
      'variants:\n  narrow:\n    top_k: 1',
      'variants:\n  narrow:\n    top_k: 1\n  remote:\n    model: opnai:gpt-5',
    );
    expect(diagnostics(text).find((x) => x.severity === 'error')).toMatchObject({
      message: 'unknown model provider "opnai"',
      hint: 'Did you mean "openai:gpt-5"?',
    });
    expect(
      diagnostics(RAG.replace('corpus: docs/*.md', 'corpus: documents/*.md'))[0]?.message,
    ).toBe('no files match corpus "documents/*.md"');
  });

  it('requires provider_options to be keyed by provider name', () => {
    const text = RAG.replace(
      '      system: Answer',
      '      provider_options: { sentences: 1 }\n      system: Answer',
    );
    expect(diagnostics(text).find((x) => x.severity === 'error')?.message).toBe(
      'provider_options keys are provider names; "sentences" is not a provider',
    );
  });

  it('warns about parameters a model does not accept', () => {
    const text = RAG.replace('model: local:extractive', 'model: anthropic:claude-opus-5').replace(
      '      system: Answer',
      '      temperature: 0\n      system: Answer',
    );
    expect(diagnostics(text)).toContainEqual(
      expect.objectContaining({
        severity: 'warning',
        message: 'anthropic:claude-opus-5 does not accept temperature; it will be omitted',
      }),
    );
  });

  it('checks evaluator types and arguments', () => {
    expect(diagnostics(RAG.replace('type: groundedness', 'type: groundness'))[0]).toMatchObject({
      hint: 'Did you mean "groundedness"?',
    });
    expect(
      diagnostics(RAG.replace('with: { max_ms: 5000 }', 'with: { max_ms: -1 }'))[0],
    ).toMatchObject({ message: 'must be > 0' });
    expect(diagnostics(RAG.replace('with: { max_ms: 5000 }', 'with: { maxms: 5 }'))[0]?.hint).toBe(
      'Did you mean "max_ms"?',
    );
  });

  it('refuses to prepare an invalid workflow', async () => {
    const { engine } = setup();
    const loaded = parseWorkflow(RAG.replace('type: llm', 'type: lm'), {
      path: join(dir, 'wf.yaml'),
      displayPath: 'wf.yaml',
      env: {},
    });
    await expect(engine.prepare(loaded)).rejects.toThrow('unknown step type "lm"');
  });
});

describe('helpers', () => {
  it('chunks markdown by heading and size', () => {
    const chunks = chunkText(`# A\n\npara one.\n\npara two.\n\n# B\n\n${'x'.repeat(50)}`, 10);
    expect(chunks).toEqual([
      { title: 'A', text: 'para one.' },
      { title: 'A', text: 'para two.' },
      { title: 'B', text: 'x'.repeat(50) },
    ]);
  });

  it('converts globs', () => {
    expect(globToRegExp('docs/**/*.md').test('docs/a/b/c.md')).toBe(true);
    expect(globToRegExp('docs/**/*.md').test('docs/c.md')).toBe(true);
    expect(globToRegExp('*.{md,txt}').test('a.txt')).toBe(true);
    expect(globToRegExp('*.md').test('a/b.md')).toBe(false);
  });
});
