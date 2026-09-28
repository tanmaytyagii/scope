/**
 * Schemas for SCOPE's configuration files. These are the source of truth for validation and for
 * the published JSON Schemas (schemas/*.schema.json). Keys are snake_case (docs/decisions/0004).
 *
 * Evolution policy: additive changes only within `version: 1`.
 */
import { z } from 'zod';

const json = z.json();

export const WORKFLOW_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const STEP_ID_PATTERN = /^[a-z_][a-z0-9_]{0,63}$/;
export const EVALUATOR_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
export const VARIANT_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

const version = z.literal(1, { error: 'must be 1 (the only configuration version so far)' });

// ─── Project configuration: scope.yaml ───────────────────────────────────────────────────────

const ProviderSettingsSchema = z.strictObject({
  /** Provider implementation. Defaults to the provider name for built-ins (openai, anthropic). */
  type: z.enum(['openai', 'anthropic', 'openai-compatible']).optional(),
  api_key: z.string().optional(),
  base_url: z.url({ error: 'must be a URL, e.g. http://localhost:11434/v1' }).optional(),
  organization: z.string().optional(),
  timeout_ms: z.number().int().positive().optional(),
  max_retries: z.number().int().min(0).max(10).optional(),
  headers: z.record(z.string(), z.string()).optional(),
});

const PriceSchema = z.strictObject({
  input: z.number().min(0),
  output: z.number().min(0),
  cache_read: z.number().min(0).optional(),
  cache_write: z.number().min(0).optional(),
  as_of: z.string().optional(),
  source: z.string().optional(),
});

const PrivacySchema = z.strictObject({
  capture_content: z.boolean().optional(),
  max_payload_bytes: z
    .number()
    .int()
    .min(256)
    .max(16 * 1024 * 1024)
    .optional(),
  redact: z.array(z.enum(['email', 'credit_card', 'us_ssn', 'phone'])).optional(),
  patterns: z
    .array(z.strictObject({ name: z.string().min(1), pattern: z.string().min(1) }))
    .optional(),
  sensitive_keys: z.array(z.string().min(1)).optional(),
});

const DefaultsSchema = z.strictObject({
  concurrency: z.number().int().min(1).max(64).optional(),
  timeout_ms: z.number().int().positive().optional(),
});

export const ProjectConfigSchema = z.strictObject({
  $schema: z.string().optional(),
  version,
  project: z
    .string()
    .regex(WORKFLOW_NAME_PATTERN, 'must be lowercase letters, digits, ".", "_" or "-"'),
  storage: z.strictObject({ url: z.string().min(1) }).optional(),
  providers: z
    .record(
      z.string().regex(/^[a-z][a-z0-9_-]*$/, 'provider names are lowercase'),
      ProviderSettingsSchema,
    )
    .optional(),
  pricing: z
    .record(z.string().regex(/^[^:\s]+:\S+$/, 'pricing keys are "provider:model"'), PriceSchema)
    .optional(),
  privacy: PrivacySchema.optional(),
  defaults: DefaultsSchema.optional(),
  workflows: z.array(z.string().min(1)).optional(),
  baselines: z.strictObject({ dir: z.string().min(1) }).optional(),
});

export type ProjectConfigFile = z.infer<typeof ProjectConfigSchema>;
export type ProviderSettings = z.infer<typeof ProviderSettingsSchema>;
export type PrivacySettings = z.infer<typeof PrivacySchema>;

// ─── Workflow files ──────────────────────────────────────────────────────────────────────────

export const INPUT_TYPES = [
  'string',
  'number',
  'integer',
  'boolean',
  'object',
  'array',
  'any',
] as const;

const InputSpecSchema = z.strictObject({
  type: z.enum(INPUT_TYPES).optional(),
  description: z.string().optional(),
  required: z.boolean().optional(),
  default: json.optional(),
});

const StepSchema = z.strictObject({
  id: z
    .string()
    .regex(
      STEP_ID_PATTERN,
      'step ids are lowercase letters, digits and "_", starting with a letter',
    ),
  type: z.string().min(1),
  name: z.string().optional(),
  description: z.string().optional(),
  with: z.record(z.string(), json).optional(),
  timeout_ms: z.number().int().positive().optional(),
  continue_on_error: z.boolean().optional(),
});

const EvaluatorSchema = z.strictObject({
  name: z
    .string()
    .regex(EVALUATOR_NAME_PATTERN, 'evaluator names are lowercase letters, digits, "_" or "-"')
    .optional(),
  type: z.string().min(1),
  description: z.string().optional(),
  threshold: z.number().min(0).max(1).optional(),
  with: z.record(z.string(), json).optional(),
});

const GateSchema = z
  .strictObject({
    metric: z.string().min(1),
    min: z.number().optional(),
    max: z.number().optional(),
    max_decrease: z.number().min(0).optional(),
    max_increase: z.number().min(0).optional(),
    max_decrease_pct: z.number().min(0).optional(),
    max_increase_pct: z.number().min(0).optional(),
    severity: z.enum(['fail', 'warn']).optional(),
  })
  .refine(
    (g) =>
      [g.min, g.max, g.max_decrease, g.max_increase, g.max_decrease_pct, g.max_increase_pct].some(
        (v) => v !== undefined,
      ),
    {
      error:
        'a gate needs at least one condition: min, max, max_decrease, max_increase, max_decrease_pct or max_increase_pct',
    },
  );

const CaseSchema = z.strictObject({
  id: z.string().min(1).max(128).optional(),
  inputs: z.record(z.string(), json),
  expected: json.optional(),
  metadata: z.record(z.string(), json).optional(),
  tags: z.array(z.string()).optional(),
});

const DatasetRefSchema = z.union([
  z.string().min(1),
  z.strictObject({ path: z.string().min(1), name: z.string().optional() }),
  z.strictObject({ name: z.string().optional(), cases: z.array(CaseSchema).min(1) }),
]);

export const WorkflowSchema = z.strictObject({
  $schema: z.string().optional(),
  version,
  name: z
    .string()
    .regex(WORKFLOW_NAME_PATTERN, 'workflow names are lowercase letters, digits, ".", "_" or "-"'),
  description: z.string().optional(),
  metadata: z.record(z.string(), json).optional(),
  inputs: z
    .record(
      z.string().regex(STEP_ID_PATTERN, 'input names are lowercase identifiers'),
      InputSpecSchema,
    )
    .optional(),
  params: z
    .record(z.string().regex(STEP_ID_PATTERN, 'param names are lowercase identifiers'), json)
    .optional(),
  variants: z
    .record(
      z.string().regex(VARIANT_NAME_PATTERN, 'variant names are lowercase'),
      z.record(z.string(), json),
    )
    .optional(),
  steps: z.array(StepSchema).min(1),
  outputs: z
    .record(z.string().regex(STEP_ID_PATTERN, 'output names are lowercase identifiers'), json)
    .optional(),
  dataset: DatasetRefSchema.optional(),
  evaluators: z.array(EvaluatorSchema).optional(),
  gates: z.array(GateSchema).optional(),
  defaults: DefaultsSchema.optional(),
});

export type WorkflowFile = z.infer<typeof WorkflowSchema>;
export type StepConfig = z.infer<typeof StepSchema>;
export type EvaluatorConfig = z.infer<typeof EvaluatorSchema>;
export type GateConfig = z.infer<typeof GateSchema>;
export type InputSpec = z.infer<typeof InputSpecSchema>;
export type CaseConfig = z.infer<typeof CaseSchema>;
export type DatasetRef = z.infer<typeof DatasetRefSchema>;

export { CaseSchema };

/** JSON Schemas for editor integration (yaml-language-server, VS Code). */
export function workflowJsonSchema(): Record<string, unknown> {
  return {
    ...z.toJSONSchema(WorkflowSchema, { io: 'input', unrepresentable: 'any' }),
    title: 'SCOPE workflow',
    description:
      'A SCOPE workflow definition. See https://github.com/tanmaytyagii/scope/blob/main/docs/guides/workflows.md',
  };
}

export function projectJsonSchema(): Record<string, unknown> {
  return {
    ...z.toJSONSchema(ProjectConfigSchema, { io: 'input', unrepresentable: 'any' }),
    title: 'SCOPE project configuration',
    description:
      'scope.yaml. See https://github.com/tanmaytyagii/scope/blob/main/docs/guides/configuration.md',
  };
}
