/**
 * Server state. One hook per endpoint; query keys mirror the URL so filters in the address bar
 * and the cache always agree. Lists use infinite queries over the API's keyset cursors.
 */
import type {
  ApiKeyList,
  BaselineComparison,
  Comparison,
  EvaluationPage,
  EvaluatorHealthList,
  ModelUsageList,
  Overview,
  Page,
  ProjectInfo,
  Run,
  RunCasePage,
  RunMatrix,
  ServerInfo,
  Span,
  TimeWindowName,
  TraceDetail,
  TracePage,
  WorkflowDetail,
  WorkflowList,
} from '@scope-ai/protocol';
import {
  keepPreviousData,
  type QueryClient,
  useInfiniteQuery,
  useQuery,
} from '@tanstack/react-query';
import { apiGet, type QueryParams } from './client.ts';

export type Filters = Record<string, string | undefined>;

function clean(filters: Filters): QueryParams {
  const out: QueryParams = {};
  for (const [k, v] of Object.entries(filters)) if (v !== undefined && v !== '') out[k] = v;
  return out;
}

function usePaged<T>(key: string, path: string, filters: Filters, pageSize = 50) {
  const params = clean(filters);
  return useInfiniteQuery({
    queryKey: [key, params],
    queryFn: ({ pageParam, signal }) =>
      apiGet<Page<T>>(path, { ...params, limit: pageSize, cursor: pageParam }, { signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
  });
}

export function allItems<T>(data: { pages: Array<Page<T>> } | undefined): T[] {
  return data?.pages.flatMap((p) => p.items) ?? [];
}

export const useServerInfo = () =>
  useQuery({
    queryKey: ['info'],
    queryFn: ({ signal }) => apiGet<ServerInfo>('/info', {}, { signal, apiKey: null }),
    staleTime: Number.POSITIVE_INFINITY,
    retry: 1,
  });

export const useProject = () =>
  useQuery({
    queryKey: ['project'],
    queryFn: ({ signal }) => apiGet<ProjectInfo>('/project', {}, { signal }),
  });

export const useApiKeys = () =>
  useQuery({
    queryKey: ['api-keys'],
    queryFn: ({ signal }) => apiGet<ApiKeyList>('/api-keys', {}, { signal }),
  });

export const useOverview = (window: TimeWindowName) =>
  useQuery({
    queryKey: ['overview', window],
    queryFn: ({ signal }) => apiGet<Overview>('/overview', { window }, { signal }),
    placeholderData: keepPreviousData,
  });

export const useRuns = (filters: Filters, pageSize?: number) =>
  usePaged<Run>('runs', '/runs', filters, pageSize);

export const useRun = (ref: string) =>
  useQuery({
    queryKey: ['run', ref],
    queryFn: ({ signal }) => apiGet<Run>(`/runs/${encodeURIComponent(ref)}`, {}, { signal }),
  });

/** How a run compared with its baseline when it ran; only runs that stored one ask for it. */
export const useBaselineComparison = (ref: string, enabled: boolean) =>
  useQuery({
    queryKey: ['baseline-comparison', ref],
    queryFn: ({ signal }) =>
      apiGet<BaselineComparison>(
        `/runs/${encodeURIComponent(ref)}/baseline-comparison`,
        {},
        { signal },
      ),
    enabled,
    // A finished run's comparison never changes.
    staleTime: Number.POSITIVE_INFINITY,
  });

export const useRunCases = (ref: string, filters: Filters) =>
  usePaged<RunCasePage['items'][number]>(
    `run-cases:${ref}`,
    `/runs/${encodeURIComponent(ref)}/cases`,
    filters,
    100,
  );

export const useComparison = (base: string, head: string, includeUnchanged: boolean) =>
  useQuery({
    queryKey: ['comparison', base, head, includeUnchanged],
    queryFn: ({ signal }) =>
      apiGet<Comparison>(
        '/comparisons',
        { base, head, includeUnchanged: includeUnchanged ? 'true' : undefined },
        { signal },
      ),
    enabled: Boolean(base && head),
    placeholderData: keepPreviousData,
  });

/** Two to four runs side by side. */
export const useRunMatrix = (runs: readonly string[]) =>
  useQuery({
    queryKey: ['run-matrix', runs.join(',')],
    queryFn: ({ signal }) =>
      apiGet<RunMatrix>('/comparisons/matrix', { runs: runs.join(',') }, { signal }),
    enabled: runs.length >= 2,
    placeholderData: keepPreviousData,
  });

export const useTraces = (filters: Filters) =>
  usePaged<TracePage['items'][number]>('traces', '/traces', filters);

/**
 * Span inputs and outputs the explorer loads with a trace. Beyond this, spans arrive without
 * content (`contentOmitted`) and load one at a time when selected, so a trace of any allowed size
 * stays a small download.
 */
export const TRACE_CONTENT_BUDGET = 2 * 1024 * 1024;

const fetchTrace = (id: string, signal: AbortSignal) =>
  apiGet<TraceDetail>(
    `/traces/${encodeURIComponent(id)}`,
    { contentBudget: TRACE_CONTENT_BUDGET },
    { signal },
  );

export const useTrace = (id: string) =>
  useQuery({
    queryKey: ['trace', id],
    queryFn: ({ signal }) => fetchTrace(id, signal),
    // A finished trace never changes; its evaluations only change on `scope evaluate`.
    staleTime: 60_000,
  });

/** One span in full; only fetched for spans that came without their content. */
export const useSpan = (traceId: string, spanId: string, enabled: boolean) =>
  useQuery({
    queryKey: ['span', traceId, spanId],
    queryFn: ({ signal }) =>
      apiGet<Span>(
        `/traces/${encodeURIComponent(traceId)}/spans/${encodeURIComponent(spanId)}`,
        {},
        { signal },
      ),
    enabled,
    staleTime: 60_000,
  });

export const useEvaluators = (window: TimeWindowName) =>
  useQuery({
    queryKey: ['evaluators', window],
    queryFn: ({ signal }) => apiGet<EvaluatorHealthList>('/evaluators', { window }, { signal }),
    placeholderData: keepPreviousData,
  });

export const useEvaluations = (filters: Filters) =>
  usePaged<EvaluationPage['items'][number]>('evaluations', '/evaluations', filters);

export const useWorkflows = () =>
  useQuery({
    queryKey: ['workflows'],
    queryFn: ({ signal }) => apiGet<WorkflowList>('/workflows', {}, { signal }),
  });

export const useWorkflow = (name: string) =>
  useQuery({
    queryKey: ['workflow', name],
    queryFn: ({ signal }) =>
      apiGet<WorkflowDetail>(`/workflows/${encodeURIComponent(name)}`, {}, { signal }),
  });

export const useModels = (window: TimeWindowName) =>
  useQuery({
    queryKey: ['models', window],
    queryFn: ({ signal }) => apiGet<ModelUsageList>('/models', { window }, { signal }),
    placeholderData: keepPreviousData,
  });

/** Warms the cache for a trace, e.g. when a row is hovered. */
export function prefetchTrace(client: QueryClient, id: string): void {
  void client.prefetchQuery({
    queryKey: ['trace', id],
    queryFn: ({ signal }) => fetchTrace(id, signal),
    staleTime: 60_000,
  });
}
