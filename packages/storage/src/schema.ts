/**
 * Database table types. Timestamps are epoch milliseconds; JSON columns are `jsonb` on
 * PostgreSQL and `text` on SQLite and are always written as serialized strings.
 */
import type { ColumnType } from 'kysely';

/** Read as unknown (parsed object on PostgreSQL, string on SQLite); written as a JSON string. */
export type JsonColumn = ColumnType<unknown, string, string>;
export type NullableJsonColumn = ColumnType<unknown, string | null, string | null>;

export interface ProjectsTable {
  id: string;
  slug: string;
  name: string;
  created_at: number;
}

export interface ApiKeysTable {
  id: string;
  project_id: string;
  name: string;
  prefix: string;
  hash: string;
  /** Comma-separated: "ingest,read". */
  scopes: string;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

export interface WorkflowsTable {
  id: string;
  project_id: string;
  name: string;
  description: string | null;
  latest_version_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface WorkflowVersionsTable {
  id: string;
  workflow_id: string;
  hash: string;
  definition: JsonColumn;
  source: string;
  path: string | null;
  created_at: number;
}

export interface RunsTable {
  id: string;
  project_id: string;
  number: number;
  workflow_id: string;
  workflow_version_id: string;
  workflow_name: string;
  variant: string | null;
  params: JsonColumn;
  dataset: NullableJsonColumn;
  status: string;
  gate_status: string;
  summary: NullableJsonColumn;
  gates: NullableJsonColumn;
  git: NullableJsonColumn;
  trigger: string;
  baseline: NullableJsonColumn;
  error: NullableJsonColumn;
  case_count: number;
  pass_rate: number | null;
  started_at: number;
  ended_at: number | null;
  duration_ms: number | null;
  /** What produced the run (migration 0003); null before SCOPE 0.4. */
  manifest: NullableJsonColumn;
}

export interface TracesTable {
  id: string;
  project_id: string;
  run_id: string | null;
  case_id: string | null;
  name: string;
  status: string;
  start_time: number;
  end_time: number;
  duration_ms: number;
  input: NullableJsonColumn;
  output: NullableJsonColumn;
  input_preview: string;
  output_preview: string;
  metadata: JsonColumn;
  error: NullableJsonColumn;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  tokens_estimated: number;
  cost_usd: number | null;
  span_count: number;
  llm_call_count: number;
  eval_status: string | null;
  eval_count: number;
  search_text: string;
  created_at: number;
}

export interface SpansTable {
  trace_id: string;
  id: string;
  project_id: string;
  parent_id: string | null;
  name: string;
  kind: string;
  status: string;
  status_message: string | null;
  start_time: number;
  end_time: number;
  duration_ms: number;
  input: NullableJsonColumn;
  output: NullableJsonColumn;
  attributes: JsonColumn;
  events: JsonColumn;
  error: NullableJsonColumn;
  provider: string | null;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
  /** 1 when the span is part of an evaluation subtree. */
  in_evaluation: number;
}

export interface EvaluationsTable {
  id: string;
  project_id: string;
  trace_id: string;
  run_id: string | null;
  span_id: string | null;
  evaluator: string;
  type: string;
  kind: string;
  status: string;
  score: number | null;
  threshold: number | null;
  reason: string;
  metadata: JsonColumn;
  duration_ms: number;
  created_at: number;
}

export interface RunComparisonsTable {
  run_id: string;
  project_id: string;
  baseline: JsonColumn;
  comparison: JsonColumn;
  created_at: number;
}

export interface Database {
  projects: ProjectsTable;
  api_keys: ApiKeysTable;
  workflows: WorkflowsTable;
  workflow_versions: WorkflowVersionsTable;
  runs: RunsTable;
  traces: TracesTable;
  spans: SpansTable;
  evaluations: EvaluationsTable;
  run_comparisons: RunComparisonsTable;
}
