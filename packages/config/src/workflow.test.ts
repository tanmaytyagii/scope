import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadDataset, prepareCases } from './dataset.ts';
import { ConfigError, type Diagnostic, renderDiagnostic } from './diagnostics.ts';
import { loadProject, resolveStorageUrl } from './project.ts';
import { workflowJsonSchema } from './schema.ts';
import { parseWorkflow, resolveParams } from './workflow.ts';

const VALID = `version: 1
name: support
inputs:
  question: { type: string }
params:
  model: local:extractive
  top_k: 3
variants:
  narrow:
    top_k: 1
steps:
  - id: retrieve
    type: retrieve
    with:
      query: "{{ inputs.question }}"
      top_k: "{{ params.top_k }}"
  - id: answer
    type: llm
    with:
      model: "{{ params.model }}"
      prompt: "{{ steps.retrieve.output.text }} {{ inputs.question }}"
outputs:
  answer: "{{ steps.answer.output.text }}"
dataset:
  cases:
    - inputs: { question: "How long do refunds take?" }
      expected: "5 days"
evaluators:
  - name: grounded
    type: groundedness
    with:
      output: "{{ outputs.answer }}"
gates:
  - metric: evaluator.grounded.mean_score
    min: 0.5
`;

function diagnosticsOf(text: string): Diagnostic[] {
  try {
    parseWorkflow(text, { path: 'wf.yaml', env: {} });
  } catch (error) {
    if (error instanceof ConfigError)
      return error.diagnostics.filter((d) => d.severity === 'error');
    throw error;
  }
  return [];
}

describe('parseWorkflow', () => {
  it('accepts a valid workflow and hashes its text', () => {
    const wf = parseWorkflow(VALID, { path: 'wf.yaml', env: {} });
    expect(wf.definition.name).toBe('support');
    expect(wf.definition.steps).toHaveLength(2);
    expect(wf.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('reports unknown keys with position and suggestion', () => {
    const [d] = diagnosticsOf(
      VALID.replace('    type: llm\n', '    type: llm\n    temprature: 0\n'),
    );
    expect(d).toMatchObject({
      message: 'unknown key "temprature"',
      line: 19,
      column: 5,
      path: 'steps[1]',
    });
    expect(d?.hint).toMatch(
      /^Step arguments go under `with:`, e.g. `with: \{ temprature: … \}`. Allowed keys: id, type/,
    );
    const withHint = diagnosticsOf(VALID.replace('name: support', 'name: support\ndescripton: x'));
    expect(withHint[0]).toMatchObject({
      message: 'unknown key "descripton"',
      hint: 'Did you mean "description"?',
      line: 3,
    });
  });

  it('reports missing required keys at the parent', () => {
    const [d] = diagnosticsOf(VALID.replace('name: support\n', ''));
    expect(d).toMatchObject({ message: 'missing required key "name"' });
  });

  it('reports type errors with the actual value', () => {
    const [d] = diagnosticsOf(VALID.replace('steps:\n', 'steps: hello\nx:\n'));
    expect(d?.message).toMatch(/expected a list, got the string "hello"/);
  });

  it('reports YAML syntax errors with a line number', () => {
    const [d] = diagnosticsOf('version: 1\nname: [broken\nsteps: []\n');
    expect(d?.message).toMatch(/^YAML syntax error/);
    expect(d?.line).toBeGreaterThan(1);
  });

  it('rejects references to later or unknown steps', () => {
    const later = diagnosticsOf(
      VALID.replace('query: "{{ inputs.question }}"', 'query: "{{ steps.answer.output.text }}"'),
    );
    expect(later[0]?.message).toBe(
      '{{ steps.answer.output.text }}: step "answer" has not run yet at this point',
    );
    expect(later[0]?.line).toBe(15);
    const typo = diagnosticsOf(
      VALID.replace('steps.retrieve.output.text', 'steps.retreive.output.text'),
    );
    expect(typo[0]).toMatchObject({
      message: '{{ steps.retreive.output.text }}: no step with id "retreive"',
      hint: 'Did you mean "retrieve"?',
    });
  });

  it('rejects unknown inputs, params and template roots', () => {
    expect(
      diagnosticsOf(
        VALID.replace('inputs.question }}"\n      top_k', 'inputs.questoin }}"\n      top_k'),
      )[0]?.hint,
    ).toBe('Did you mean "question"?');
    expect(diagnosticsOf(VALID.replace('params.top_k', 'params.topk'))[0]?.message).toContain(
      'no param named "topk"',
    );
    expect(
      diagnosticsOf(VALID.replace('{{ outputs.answer }}', '{{ output.answer }}'))[0]?.hint,
    ).toContain('Did you mean "outputs"?');
  });

  it('reports template syntax errors', () => {
    const [d] = diagnosticsOf(
      VALID.replace(
        '{{ inputs.question }}"\n      top_k',
        '{{ inputs.question | uppercase }}"\n      top_k',
      ),
    );
    expect(d).toMatchObject({
      message: 'Unknown filter "uppercase" in {{ inputs.question | uppercase }}',
      hint: 'Did you mean "upper"?',
    });
  });

  it('checks duplicate ids, variant params and gate metrics', () => {
    expect(diagnosticsOf(VALID.replace('- id: answer', '- id: retrieve'))[0]?.message).toBe(
      'duplicate step id "retrieve"',
    );
    expect(diagnosticsOf(VALID.replace('    top_k: 1', '    topk: 1'))[0]?.message).toBe(
      'variant "narrow" overrides "topk", which is not declared in params',
    );
    const gate = diagnosticsOf(
      VALID.replace('evaluator.grounded.mean_score', 'evaluator.grouded.mean_score'),
    );
    expect(gate[0]).toMatchObject({ hint: 'Did you mean "evaluator.grounded.mean_score"?' });
    expect(
      diagnosticsOf(VALID.replace('evaluator.grounded.mean_score', 'latency.p99_ms'))[0]?.message,
    ).toBe('unknown metric "latency.p99_ms"');
  });

  it('resolves env references and reports missing ones', () => {
    const text = VALID.replace(
      'model: local:extractive',
      'model: "${env:SCOPE_TEST_MODEL:-local:echo}"',
    );
    expect(parseWorkflow(text, { path: 'wf.yaml', env: {} }).definition.params?.model).toBe(
      'local:echo',
    );
    const [d] = diagnosticsOf(
      VALID.replace('model: local:extractive', 'model: "${env:SCOPE_UNSET_VAR}"'),
    );
    expect(d?.message).toBe('environment variable SCOPE_UNSET_VAR is not set');
  });

  it('renders a diagnostic with a code frame', () => {
    const text = VALID.replace('name: support', 'name: support\ndescripton: x');
    try {
      parseWorkflow(text, { path: 'wf.yaml', env: {} });
      expect.unreachable();
    } catch (error) {
      const rendered = renderDiagnostic((error as ConfigError).diagnostics[0] as Diagnostic, text);
      expect(rendered).toBe(
        [
          'error  wf.yaml:3:1',
          '  unknown key "descripton"',
          '',
          '    2 │ name: support',
          '  > 3 │ descripton: x',
          '      │ ^^^^^^^^^^',
          '    4 │ inputs:',
          '',
          '  hint: Did you mean "description"?',
        ].join('\n'),
      );
    }
  });
});

describe('resolveParams', () => {
  const wf = parseWorkflow(VALID, { path: 'wf.yaml', env: {} }).definition;
  it('applies variant overrides', () => {
    expect(resolveParams(wf, null)).toEqual({ model: 'local:extractive', top_k: 3 });
    expect(resolveParams(wf, 'narrow')).toEqual({ model: 'local:extractive', top_k: 1 });
  });
  it('suggests close variant names', () => {
    expect(() => resolveParams(wf, 'narow')).toThrow(ConfigError);
    try {
      resolveParams(wf, 'narow');
    } catch (error) {
      expect((error as ConfigError).hint).toBe('Did you mean "narrow"?');
    }
  });
});

describe('datasets', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scope-config-'));
  it('loads JSONL with flat and structured cases and stable ids', () => {
    writeFileSync(
      join(dir, 'cases.jsonl'),
      [
        '{"id": "refund", "inputs": {"question": "Refund time?"}, "expected": "5 days"}',
        '',
        '{"question": "Do you ship to Canada?", "expected": "yes", "tags": ["shipping"]}',
      ].join('\n'),
    );
    const ds = loadDataset('cases.jsonl', { baseDir: dir, root: dir, workflowName: 'wf' });
    expect(ds.name).toBe('cases');
    expect(ds.cases.map((c) => c.id)).toEqual(['refund', expect.stringMatching(/^c-[0-9a-f]{8}$/)]);
    expect(ds.cases[1]).toMatchObject({
      inputs: { question: 'Do you ship to Canada?' },
      expected: 'yes',
      tags: ['shipping'],
    });
    const again = loadDataset('cases.jsonl', { baseDir: dir, root: dir, workflowName: 'wf' });
    expect(again.hash).toBe(ds.hash);
  });

  it('reports invalid JSONL lines', () => {
    writeFileSync(join(dir, 'bad.jsonl'), '{"a": 1}\n{"a": \n');
    expect(() => loadDataset('bad.jsonl', { baseDir: dir, root: dir, workflowName: 'wf' })).toThrow(
      /invalid JSON on line 2/,
    );
  });

  it('rejects duplicate explicit ids', () => {
    writeFileSync(
      join(dir, 'dup.yaml'),
      '- { id: a, inputs: { q: 1 } }\n- { id: a, inputs: { q: 2 } }\n',
    );
    expect(() => loadDataset('dup.yaml', { baseDir: dir, root: dir, workflowName: 'wf' })).toThrow(
      /duplicate case id "a"/,
    );
  });

  it('applies defaults and validates input types', () => {
    const ds = loadDataset(
      { cases: [{ inputs: { question: 'hi' } }, { inputs: { question: 42 } }] },
      { baseDir: dir, root: dir, workflowName: 'wf' },
    );
    expect(() =>
      prepareCases(ds, { question: { type: 'string' }, tone: { default: 'friendly' } }),
    ).toThrow(/input "question" should be string, got number/);
    const ok = prepareCases(
      { ...ds, cases: ds.cases.slice(0, 1) },
      { question: { type: 'string' }, tone: { default: 'friendly' } },
    );
    expect(ok.cases[0]?.inputs).toEqual({ question: 'hi', tone: 'friendly' });
  });

  it('points at a misspelled input when a required one is missing', () => {
    const ds = loadDataset(
      { cases: [{ id: 'typo', inputs: { questoin: 'hi' } }] },
      { baseDir: dir, root: dir, workflowName: 'wf' },
    );
    try {
      prepareCases(ds, { question: { type: 'string' } });
      expect.unreachable();
    } catch (error) {
      expect((error as ConfigError).diagnostics[0]).toMatchObject({
        message: 'case "typo" is missing required input "question"',
        hint: 'The case has "questoin" — did you mean "question"?',
      });
    }
  });
});

describe('loadProject', () => {
  it('uses defaults without scope.yaml', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scope-project-'));
    const project = loadProject({ cwd: dir, env: {} });
    expect(project.configPath).toBeNull();
    expect(project.storage).toEqual({
      url: `sqlite:${join(dir, '.scope/scope.db')}`,
      source: 'default',
    });
    expect(project.defaults.concurrency).toBe(4);
  });

  it('finds scope.yaml in a parent directory and applies env overrides', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scope-project-'));
    writeFileSync(
      join(dir, 'scope.yaml'),
      [
        'version: 1',
        'project: acme-support',
        'providers:',
        '  ollama:',
        '    type: openai-compatible',
        '    base_url: http://localhost:11434/v1',
        '    api_key: ${env:OLLAMA_KEY}',
        'pricing:',
        '  "acme:model-x": { input: 1, output: 2 }',
        'privacy:',
        '  redact: [email]',
      ].join('\n'),
    );
    mkdirSync(join(dir, 'workflows'));
    const project = loadProject({
      cwd: join(dir, 'workflows'),
      env: { SCOPE_DATABASE_URL: 'postgres://localhost/scope', SCOPE_CAPTURE_CONTENT: 'false' },
    });
    expect(project.root).toBe(dir);
    expect(project.name).toBe('acme-support');
    expect(project.storage).toEqual({ url: 'postgres://localhost/scope', source: 'env' });
    expect(project.privacy).toEqual({ redact: ['email'], captureContent: false });
    expect(project.providers.ollama?.missingEnv).toEqual(['OLLAMA_KEY']);
    expect(project.pricing['acme:model-x']).toMatchObject({ input: 1, output: 2 });
    expect(project.diagnostics[0]).toMatchObject({ severity: 'warning', line: 7 });
  });

  it('resolves relative sqlite urls', () => {
    expect(resolveStorageUrl('sqlite:data/x.db', '/p')).toBe('sqlite:/p/data/x.db');
    expect(resolveStorageUrl('sqlite:/abs/x.db', '/p')).toBe('sqlite:/abs/x.db');
    expect(resolveStorageUrl('sqlite::memory:', '/p')).toBe('sqlite::memory:');
  });
});

describe('workflowJsonSchema', () => {
  it('produces a JSON Schema with strict objects', () => {
    const schema = workflowJsonSchema() as {
      properties: Record<string, unknown>;
      additionalProperties: boolean;
    };
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties)).toContain('steps');
  });
});
