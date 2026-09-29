/**
 * The `/api/v1` route table: one entry per operation. It drives the OpenAPI document, and the
 * server's tests check that every entry is served.
 */
import type { z } from 'zod';
import { WindowQuery } from './common.ts';
import { IngestRequest, IngestResponse } from './ingest.ts';
import {
  ComparisonQuery,
  EvaluationsQuery,
  RunCasesQuery,
  RunMatrixQuery,
  RunsQuery,
  TracesQuery,
} from './queries.ts';
import {
  ApiKeyList,
  BaselineComparison,
  Comparison,
  EvaluationPage,
  EvaluatorHealthList,
  ModelUsageList,
  Overview,
  ProjectInfo,
  Run,
  RunCasePage,
  RunMatrix,
  RunPage,
  ServerInfo,
  TraceDetail,
  TracePage,
  WorkflowDetail,
  WorkflowList,
} from './resources.ts';

export const API_BASE = '/api/v1';

/** What a caller needs: nothing, or an API key with this scope (when the server uses keys). */
export type RouteAccess = 'public' | 'read' | 'ingest';

export interface RouteParam {
  name: string;
  description: string;
}

export interface RouteDefinition {
  method: 'get' | 'post';
  /** Path below /api/v1, OpenAPI style: "/runs/{run}". */
  path: string;
  operationId: string;
  summary: string;
  description?: string;
  tag: string;
  access: RouteAccess;
  params?: RouteParam[];
  query?: z.ZodObject;
  body?: z.ZodType;
  response: z.ZodType;
  /** Error statuses this operation can return besides 401/403/500. */
  errors?: number[];
}

const RUN_PARAM: RouteParam = { name: 'run', description: 'Run id or number ("42").' };

export const ROUTES: readonly RouteDefinition[] = [
  {
    method: 'get',
    path: '/info',
    operationId: 'getServerInfo',
    summary: 'Server version and authentication mode',
    tag: 'Server',
    access: 'public',
    response: ServerInfo,
  },
  {
    method: 'get',
    path: '/project',
    operationId: 'getProject',
    summary: 'Project, storage, privacy policy, pricing table and row counts',
    tag: 'Server',
    access: 'read',
    response: ProjectInfo,
  },
  {
    method: 'get',
    path: '/api-keys',
    operationId: 'listApiKeys',
    summary: 'API keys of the project (metadata only; secrets are never returned)',
    tag: 'Server',
    access: 'read',
    response: ApiKeyList,
  },
  {
    method: 'get',
    path: '/overview',
    operationId: 'getOverview',
    summary: 'Headline metrics, time series, run trend and recent failures',
    tag: 'Analytics',
    access: 'read',
    query: WindowQuery,
    response: Overview,
    errors: [400],
  },
  {
    method: 'get',
    path: '/runs',
    operationId: 'listRuns',
    summary: 'List runs, newest first',
    tag: 'Runs',
    access: 'read',
    query: RunsQuery,
    response: RunPage,
    errors: [400],
  },
  {
    method: 'get',
    path: '/runs/{run}',
    operationId: 'getRun',
    summary: 'A run with its summary, gates and evaluator breakdown',
    tag: 'Runs',
    access: 'read',
    params: [RUN_PARAM],
    response: Run,
    errors: [400, 404],
  },
  {
    method: 'get',
    path: '/runs/{run}/baseline-comparison',
    operationId: 'getBaselineComparison',
    summary: 'How a run compared with its baseline file: metric deltas and changed cases',
    tag: 'Runs',
    access: 'read',
    params: [RUN_PARAM],
    response: BaselineComparison,
    errors: [400, 404],
  },
  {
    method: 'get',
    path: '/runs/{run}/cases',
    operationId: 'listRunCases',
    summary: 'Per-case results of a run, ordered by case id',
    tag: 'Runs',
    access: 'read',
    params: [RUN_PARAM],
    query: RunCasesQuery,
    response: RunCasePage,
    errors: [400, 404],
  },
  {
    method: 'get',
    path: '/comparisons',
    operationId: 'compareRuns',
    summary: 'Compare two runs metric by metric and case by case',
    tag: 'Runs',
    access: 'read',
    query: ComparisonQuery,
    response: Comparison,
    errors: [400, 404],
  },
  {
    method: 'get',
    path: '/comparisons/matrix',
    operationId: 'compareManyRuns',
    summary: 'Two to four runs side by side: metrics per run and the cases whose outcome differs',
    tag: 'Runs',
    access: 'read',
    query: RunMatrixQuery,
    response: RunMatrix,
    errors: [400, 404],
  },
  {
    method: 'get',
    path: '/traces',
    operationId: 'listTraces',
    summary: 'List traces with filters, search and sorting',
    tag: 'Traces',
    access: 'read',
    query: TracesQuery,
    response: TracePage,
    errors: [400, 404],
  },
  {
    method: 'get',
    path: '/traces/{trace}',
    operationId: 'getTrace',
    summary: 'A trace with every span and evaluation',
    tag: 'Traces',
    access: 'read',
    params: [
      { name: 'trace', description: 'Trace id, or a unique prefix of at least 4 characters.' },
    ],
    response: TraceDetail,
    errors: [400, 404],
  },
  {
    method: 'get',
    path: '/evaluators',
    operationId: 'listEvaluatorHealth',
    summary: 'Pass rate, scores and recent trend of every evaluator',
    tag: 'Evaluations',
    access: 'read',
    query: WindowQuery,
    response: EvaluatorHealthList,
    errors: [400],
  },
  {
    method: 'get',
    path: '/evaluations',
    operationId: 'listEvaluations',
    summary: 'Individual evaluation results, newest first',
    tag: 'Evaluations',
    access: 'read',
    query: EvaluationsQuery,
    response: EvaluationPage,
    errors: [400, 404],
  },
  {
    method: 'get',
    path: '/workflows',
    operationId: 'listWorkflows',
    summary: 'Workflows with their latest run',
    tag: 'Workflows',
    access: 'read',
    response: WorkflowList,
  },
  {
    method: 'get',
    path: '/workflows/{workflow}',
    operationId: 'getWorkflow',
    summary: 'A workflow’s latest definition, versions and variants',
    tag: 'Workflows',
    access: 'read',
    params: [{ name: 'workflow', description: 'Workflow name.' }],
    response: WorkflowDetail,
    errors: [404],
  },
  {
    method: 'get',
    path: '/models',
    operationId: 'listModels',
    summary: 'Calls, tokens, latency, errors and estimated cost per model',
    tag: 'Analytics',
    access: 'read',
    query: WindowQuery,
    response: ModelUsageList,
    errors: [400],
  },
  {
    method: 'post',
    path: '/ingest',
    operationId: 'ingest',
    summary: 'Store finished traces with their spans and evaluations',
    description:
      'Used by SDKs. Idempotent per trace id. Payloads are redacted and size-bounded by the server’s privacy policy before storage.',
    tag: 'Ingestion',
    access: 'ingest',
    body: IngestRequest,
    response: IngestResponse,
    errors: [400, 413, 415],
  },
];
