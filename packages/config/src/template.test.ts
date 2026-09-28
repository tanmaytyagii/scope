import { describe, expect, it } from 'vitest';
import { resolveEnvRefs } from './env.ts';
import {
  asText,
  renderDeep,
  renderTemplate,
  TemplateError,
  templateReferences,
} from './template.ts';

const scope = {
  inputs: { question: 'Where is my order?', tags: ['a', 'b'] },
  params: { top_k: 3, style: '' },
  steps: {
    retrieve: {
      output: {
        documents: [{ text: 'Doc one.' }, { text: 'Doc two.' }],
        text: 'Doc one.\nDoc two.',
      },
    },
    answer: { output: { text: 'It shipped.', json: { ok: true } } },
  },
};

describe('renderTemplate', () => {
  it('interpolates text', () => {
    expect(renderTemplate('Q: {{ inputs.question }}!', scope)).toBe('Q: Where is my order?!');
  });

  it('preserves types for single expressions', () => {
    expect(renderTemplate('{{ params.top_k }}', scope)).toBe(3);
    expect(renderTemplate('  {{steps.answer.output.json}}  ', scope)).toBe(
      `  ${JSON.stringify({ ok: true }, null, 2)}  `,
    );
    expect(renderTemplate('{{ steps.answer.output.json }}', scope)).toEqual({ ok: true });
  });

  it('supports indexing and filters', () => {
    expect(renderTemplate('{{ steps.retrieve.output.documents[1].text }}', scope)).toBe('Doc two.');
    expect(renderTemplate('{{ steps.retrieve.output.documents.0.text | upper }}', scope)).toBe(
      'DOC ONE.',
    );
    expect(renderTemplate('{{ inputs.tags | join(" / ") }}', scope)).toBe('a / b');
    expect(renderTemplate('{{ steps.retrieve.output.documents | length }}', scope)).toBe(2);
    expect(renderTemplate('{{ params.style | default("concise") }}', scope)).toBe('concise');
    expect(renderTemplate('{{ params.missing | default(5) }}', scope)).toBe(5);
    expect(renderTemplate('{{ inputs.question | truncate(5) }}', scope)).toBe('Where…');
    expect(renderTemplate('{{ steps.answer.output.json | json }}', scope)).toBe('{"ok":true}');
    expect(renderTemplate('{{ "{{" }} literal', scope)).toBe('{{ literal');
  });

  it('explains missing paths with suggestions', () => {
    expect(() => renderTemplate('{{ steps.answer.output.txt }}', scope)).toThrow(TemplateError);
    try {
      renderTemplate('{{ steps.answer.output.txt }}', scope);
    } catch (error) {
      expect((error as TemplateError).message).toBe(
        '{{ steps.answer.output.txt }}: "txt" does not exist in steps.answer.output',
      );
      expect((error as TemplateError).hint).toBe('Did you mean "text"?');
    }
  });

  it('rejects code-like expressions', () => {
    expect(() => renderTemplate('{{ inputs.question + 1 }}', scope)).toThrow(/Unexpected "\+ 1"/);
    expect(() => renderTemplate('{{ inputs.question', scope)).toThrow(/Unclosed/);
  });

  it('renders nested structures', () => {
    expect(renderDeep({ a: ['{{ params.top_k }}', 'x {{ inputs.tags.0 }}'], b: 1 }, scope)).toEqual(
      { a: [3, 'x a'], b: 1 },
    );
  });

  it('lists references for static checks', () => {
    expect(
      templateReferences('{{ inputs.q }} and {{ steps.a.output | default("") }} {{ "lit" }}'),
    ).toEqual([
      { segments: ['inputs', 'q'], optional: false, expression: 'inputs.q' },
      {
        segments: ['steps', 'a', 'output'],
        optional: true,
        expression: 'steps.a.output | default("")',
      },
    ]);
  });
});

describe('asText', () => {
  it('extracts text from model outputs', () => {
    expect(asText({ text: 'hi', usage: {} })).toBe('hi');
    expect(asText(['a'])).toBe('[\n  "a"\n]');
    expect(asText(null)).toBe('');
  });
});

describe('resolveEnvRefs', () => {
  it('substitutes values and defaults, reporting missing names', () => {
    expect(resolveEnvRefs('${env:A}/${env:B:-fallback}/${env:C}', { A: '1' })).toEqual({
      value: '1/fallback/',
      missing: ['C'],
    });
  });
});
