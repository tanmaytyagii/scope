/**
 * Records returned by the store. These are storage-level shapes (camelCase, epoch ms); the HTTP
 * API maps them to its own DTOs.
 */
import type {
  DatasetInfo,
  ErrorInfo,
  EvaluationStatus,
  EvaluatorKind,
  GateResult,
  GateStatus,
  GitInfo,
  JsonObject,
  RunStatus,
  RunSummary,
  RunTrigger,
  SpanStatus,
} from '@scope-ai/core';

export interface Project {
  id: string;
  slug: string;
  name: string;
  createdAt: number;
}

export type ApiKeyScope = 'ingest' | 'read';

export interface ApiKey {
  id: string;
  projectId: string;
  name: string;
  prefix: string;
  scopes: ApiKeyScope[];
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

export interface BaselineRef {
  file: string;
  runNumber: number;
  commit: string | null;
  createdAt: string;
}

export interface Run {
  id: string;
  projectId: string;
  number: number;
  workflowId: string;
  workflowName: string;
  workflowVersionId: string;
  variant: string | null;
  params: JsonObject;
  dataset: DatasetInfo | null;
  status: RunStatus;
  gateStatus: GateStatus;
  summary: RunSummary | null;
  gates: GateResult[];
  git: GitInfo | null;
  trigger: RunTrigger;
  baseline: BaselineRef | null;
  error: ErrorInfo | null;
  caseCount: number;
  passRate: number | null;
  startedAt: number;
  endedAt: number | null;
  durationMs: number | null;
}

export interface TraceSummary {
  id: string;
  runId: string | null;
  runNumber: number | null;
  caseId: string | null;
  name: string;
  status: SpanStatus;
  startTime: number;
  durationMs: number;
  inputPreview: string;
  outputPreview: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  tokensEstimated: boolean;
  costUsd: number | null;
  spanCount: number;
  llmCallCount: number;
  evalStatus: 'passed' | 'failed' | 'errored' | null;
  evalCount: number;
  error: ErrorInfo | null;
}

export interface CaseEvaluation {
  evaluator: string;
  type: string;
  kind: EvaluatorKind;
  status: EvaluationStatus;
  score: number | null;
  reason: string;
}

export interface RunCase {
  caseId: string;
  traceId: string;
  status: SpanStatus;
  outcome: 'passed' | 'failed' | 'errored';
  durationMs: number;
  totalTokens: number;
  costUsd: number | null;
  inputPreview: string;
  outputPreview: string;
  error: ErrorInfo | null;
  evaluations: CaseEvaluation[];
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface WorkflowSummary {
  id: string;
  name: string;
  description: string | null;
  versionCount: number;
  runCount: number;
  updatedAt: number;
  lastRun: Pick<
    Run,
    'id' | 'number' | 'variant' | 'status' | 'gateStatus' | 'passRate' | 'startedAt'
  > | null;
}

export interface WorkflowVersion {
  id: string;
  hash: string;
  path: string | null;
  createdAt: number;
}

export interface WorkflowDetail {
  id: string;
  name: string;
  description: string | null;
  updatedAt: number;
  versions: WorkflowVersion[];
  latest: {
    id: string;
    hash: string;
    source: string;
    definition: unknown;
    path: string | null;
  } | null;
}
