/**
 * Files created by `scope init`. The starter project is a retrieval-augmented support assistant
 * over a small help center. It runs offline on the deterministic `local:extractive` model, so the
 * first run needs no API key; switching `params.model` to a real model is a one-line change.
 */

export interface TemplateFile {
  path: string;
  content: string;
}

const SCOPE_YAML = `# yaml-language-server: $schema=.scope/schemas/project.schema.json
# SCOPE project configuration. Docs: https://github.com/tanmaytyagii/scope/blob/main/docs/guides/configuration.md
version: 1
project: {{project}}

# Where runs, traces and evaluations are stored. Defaults to a local SQLite file.
# Override with SCOPE_DATABASE_URL (e.g. postgres://… for a shared server).
storage:
  url: sqlite:.scope/scope.db

# Provider credentials come from OPENAI_API_KEY / ANTHROPIC_API_KEY by default.
# Add OpenAI-compatible endpoints (Ollama, vLLM, OpenRouter, …) here:
# providers:
#   ollama:
#     type: openai-compatible
#     base_url: http://localhost:11434/v1

privacy:
  # Prompts and outputs are stored so you can inspect them. Set to false for sensitive data.
  capture_content: true

workflows:
  - workflows/*.yaml
`;

const WORKFLOW = `# yaml-language-server: $schema=../.scope/schemas/workflow.schema.json
# A retrieval-augmented support assistant, evaluated on every run.
# Docs: https://github.com/tanmaytyagii/scope/blob/main/docs/guides/workflows.md
version: 1
name: support
description: Answers customer questions from the help center in docs/.

inputs:
  question:
    type: string
    description: The customer's question.

params:
  # local:extractive is an offline, deterministic stand-in (not a language model): it answers
  # with the context sentences that best match the question. To use a real model, set e.g.
  #   model: anthropic:claude-opus-5   (needs ANTHROPIC_API_KEY)
  #   model: openai:gpt-5              (needs OPENAI_API_KEY)
  model: local:extractive
  top_k: 3
  # Only used by local:extractive: how many context sentences it answers with.
  sentences: 2

# Named parameter overrides. Run one with --variant terse, or all with --all-variants.
variants:
  terse:
    sentences: 1
  narrow:
    top_k: 1

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
      system: |
        You are a support assistant. Answer using only the context.
        If the context does not contain the answer, say you could not find it.
      prompt: |
        Context:
        {{ steps.retrieve.output.text }}

        Question: {{ inputs.question }}
      max_tokens: 400
      # Options for one provider only; ignored when another provider serves the call.
      provider_options:
        local:
          sentences: "{{ params.sentences }}"

outputs:
  answer: "{{ steps.answer.output.text }}"

dataset: ../datasets/support.jsonl

evaluators:
  # heuristic: share of answer sentences supported by the retrieved context
  - name: grounded
    type: groundedness
  # heuristic: numbers and names in the answer that never appear in the context
  - name: no_invented_facts
    type: unsupported_claims
  # deterministic: the answer contains the key facts listed as "expected" in the dataset
  - name: key_facts
    type: contains
  # deterministic: the workflow finished within budget
  - name: fast
    type: latency
    with:
      max_ms: 2000

gates:
  - metric: pass_rate
    min: 0.6
  - metric: evaluator.grounded.mean_score
    min: 0.8
  # Regression gates compare against a baseline (scope baseline save). Skipped without one.
  - metric: pass_rate
    max_decrease: 0.05
  - metric: latency.p95_ms
    max_increase_pct: 50
    severity: warn
`;

const DATASET = [
  {
    id: 'refund-timing',
    inputs: { question: 'How long does it take to get a refund?' },
    expected: ['5 to 7 business days'],
  },
  {
    id: 'refund-method',
    inputs: { question: 'Will my refund go back to my credit card?' },
    expected: ['original payment method'],
  },
  {
    id: 'return-window',
    inputs: { question: 'How many days do I have to return an item?' },
    expected: ['30 days'],
  },
  {
    id: 'gift-card-refund',
    inputs: { question: 'Can I get a refund on a gift card?' },
    expected: ['cannot be refunded'],
  },
  {
    id: 'free-shipping',
    inputs: { question: 'Which orders qualify for free shipping?' },
    expected: ['$50'],
  },
  {
    id: 'express-shipping',
    inputs: { question: 'How fast is express shipping?' },
    expected: ['1 to 2 business days'],
  },
  { id: 'international', inputs: { question: 'Do you ship to Canada?' }, expected: ['Canada'] },
  {
    id: 'password-reset',
    inputs: { question: 'I forgot my password. How do I reset it?' },
    expected: ['Forgot password'],
  },
  {
    id: 'delete-account',
    inputs: { question: 'How do I delete my account?' },
    expected: ['Account settings', '30 days'],
  },
  {
    id: 'warranty-length',
    inputs: { question: 'How long is the warranty on electronics?' },
    expected: ['2 years'],
  },
  {
    id: 'warranty-damage',
    inputs: { question: 'Does the warranty cover water damage?' },
    expected: ['accidental damage'],
  },
  {
    id: 'store-hours',
    inputs: { question: 'What time does the downtown store open on Sundays?' },
    expected: ['could not find'],
  },
]
  .map((c) => JSON.stringify(c))
  .join('\n');

const DOCS: Record<string, string> = {
  'docs/returns.md': `# Returns and refunds

## Return window

You can return most items within 30 days of delivery. Items must be unused and in their original packaging. Final-sale items are marked on the product page and cannot be returned.

## Refunds

Refunds are issued to the original payment method. Once we receive your return, refunds take 5 to 7 business days to appear on your statement. You will get an email when the refund is issued.

## Gift cards

Gift cards cannot be refunded or exchanged for cash. A lost gift card can be replaced if you have the original receipt.
`,
  'docs/shipping.md': `# Shipping

## Delivery times

Standard shipping takes 3 to 5 business days. Express shipping takes 1 to 2 business days and costs $15.

## Free shipping

Orders over $50 ship free with standard shipping within the United States.

## International shipping

We ship to Canada, the United Kingdom and the European Union. International orders take 7 to 14 business days. Import duties are paid by the recipient.
`,
  'docs/account.md': `# Your account

## Password reset

To reset your password, select Forgot password on the sign-in page and follow the link we email you. The link expires after 1 hour.

## Two-factor authentication

You can turn on two-factor authentication in Account settings under Security. We support authenticator apps and hardware security keys.

## Deleting your account

You can delete your account from Account settings under Privacy. Deletion is permanent after 30 days; until then you can sign in to cancel it.
`,
  'docs/warranty.md': `# Warranty

## Coverage

Electronics come with a 2 years limited warranty from the date of purchase. Other products carry a 1 year warranty.

## What is not covered

The warranty does not cover accidental damage, including drops and water damage, or normal wear and tear.

## Making a claim

Start a claim from your order history. Include photos of the problem and your order number.
`,
};

export function starterTemplate(project: string): TemplateFile[] {
  return [
    { path: 'scope.yaml', content: SCOPE_YAML.replace('{{project}}', project) },
    { path: 'workflows/support.yaml', content: WORKFLOW },
    { path: 'datasets/support.jsonl', content: `${DATASET}\n` },
    ...Object.entries(DOCS).map(([path, content]) => ({ path, content })),
  ];
}

export const GITIGNORE_ENTRY = '.scope/';
