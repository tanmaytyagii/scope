/**
 * Test data from real executions: writes a small offline workflow to a directory, runs it with
 * the engine (as `scope run` does) and stores the runs. No fixtures, no mocked rows.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadDataset, loadWorkflow, prepareCases } from '@scope-ai/config';
import { evaluateGates, gateStatus, summarizeRun } from '@scope-ai/core';
import { Engine, toCaseResult } from '@scope-ai/engine';
import type { Project, Run, Store } from '@scope-ai/storage';

const DOCS: Record<string, string> = {
  'refunds.md': [
    '# Refunds',
    '',
    'Refunds are issued to the original payment method.',
    'Refunds take 5 to 7 business days to appear on a card statement.',
    '',
    '# Gift cards',
    '',
    'Gift cards cannot be refunded or exchanged for cash.',
  ].join('\n'),
  'shipping.md': [
    '# Shipping',
    '',
    'Standard shipping takes 3 to 5 business days.',
    'Orders over $50 ship free within the United States.',
  ].join('\n'),
};

const CASES = [
  { id: 'refund-time', q: 'How long does a refund take?', expected: ['5 to 7 business days'] },
  { id: 'refund-method', q: 'Where does my refund go?', expected: ['original payment method'] },
  { id: 'gift-cards', q: 'Can I refund a gift card?', expected: ['cannot be refunded'] },
  { id: 'free-shipping', q: 'When is shipping free?', expected: ['Orders over $50'] },
  // The retrieved context does not contain this fact, so key_facts fails: a real failure.
  { id: 'store-hours', q: 'When does the store open?', expected: ['9 am'] },
];

const WORKFLOW = `version: 1
name: support
description: Answers questions from the help center.
inputs:
  question: { type: string }
params:
  model: local:extractive
  top_k: 2
  sentences: 2
variants:
  terse:
    sentences: 1
steps:
  - id: retrieve
    type: retrieve
    with:
      query: "{{ inputs.question }}"
      corpus: ../docs/*.md
      top_k: "{{ params.top_k }}"
  - id: answer
    type: llm
    with:
      model: "{{ params.model }}"
      prompt: |
        Context:
        {{ steps.retrieve.output.text }}
        Question: {{ inputs.question }}
      provider_options:
        local:
          sentences: "{{ params.sentences }}"
outputs:
  answer: "{{ steps.answer.output.text }}"
dataset: ../datasets/support.jsonl
evaluators:
  - name: grounded
    type: groundedness
  - name: key_facts
    type: contains
gates:
  - metric: pass_rate
    min: 0.5
`;

export function writeProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'scope-server-'));
  for (const dir of ['docs', 'datasets', 'workflows']) mkdirSync(join(root, dir));
  for (const [name, text] of Object.entries(DOCS)) writeFileSync(join(root, 'docs', name), text);
  writeFileSync(
    join(root, 'datasets', 'support.jsonl'),
    `${CASES.map((c) => JSON.stringify({ id: c.id, inputs: { question: c.q }, expected: c.expected })).join('\n')}\n`,
  );
  writeFileSync(join(root, 'workflows', 'support.yaml'), WORKFLOW);
  return root;
}

/** Runs the workflow once per variant and stores each run, like `scope run --variant`. */
export async function runWorkflow(
  store: Store,
  project: Project,
  root: string,
  variant: string | null = null,
): Promise<Run> {
  const loaded = loadWorkflow(resolve(root, 'workflows/support.yaml'), { root, env: {} });
  const engine = new Engine({
    project: {
      root,
      providers: {},
      pricing: {},
      privacy: {},
      defaults: { concurrency: 2, timeoutMs: null },
    },
    exporter: { export: (bundle) => store.ingest(project.id, [bundle]).then(() => undefined) },
    env: {},
  });
  const prepared = await engine.prepare(loaded, { variant });
  const dataset = loadDataset(loaded.definition.dataset as string, {
    baseDir: resolve(loaded.path, '..'),
    root,
    workflowName: loaded.definition.name,
  });
  const { cases } = prepareCases(dataset, loaded.definition.inputs);
  const version = await store.registerWorkflowVersion(project.id, {
    name: loaded.definition.name,
    description: loaded.definition.description ?? null,
    hash: loaded.hash,
    definition: loaded.definition,
    source: loaded.text,
    path: 'workflows/support.yaml',
  });
  const run = await store.createRun({
    projectId: project.id,
    workflowId: version.workflowId,
    workflowVersionId: version.versionId,
    workflowName: prepared.name,
    variant: prepared.variant,
    params: prepared.params,
    dataset: {
      name: dataset.name,
      source: dataset.source,
      caseCount: dataset.cases.length,
      hash: dataset.hash,
    },
    git: null,
    trigger: 'cli',
    baseline: null,
    caseCount: cases.length,
  });
  const result = await engine.run(prepared, cases, { runId: run.id });
  const summary = summarizeRun(result.executions.map(toCaseResult), {
    evaluatorOrder: prepared.evaluators.map((e) => e.name),
  });
  const gates = evaluateGates(summary, prepared.gates, null);
  return store.completeRun(run.id, {
    status: 'completed',
    summary,
    gates,
    gateStatus: gateStatus(gates),
  });
}
