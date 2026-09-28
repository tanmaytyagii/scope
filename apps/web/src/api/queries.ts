/**
 * Server state. One hook per endpoint; query keys mirror the URL so filters in the address bar
 * and the cache always agree. Lists use infinite queries over the API's keyset cursors.
 */
import type {
  ApiKeyList,
  Comparison,
  EvaluationPage,
  EvaluatorHealthList,
  ModelUsageList,
  Overview,
  Page,
  ProjectInfo,
  Run,
  RunCasePage,
  ServerInfo,
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

export const useTraces = (filters: Filters) =>
  usePaged<TracePage['items'][number]>('traces', '/traces', filters);

export const useTrace = (id: string) =>
  useQuery({
    queryKey: ['trace', id],
    queryFn: ({ signal }) =>
      apiGet<TraceDetail>(`/traces/${encodeURIComponent(id)}`, {}, { signal }),
    // A finished trace never changes; its evaluations only change on `scope evaluate`.
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
    queryFn: ({ signal }) =>
      apiGet<TraceDetail>(`/traces/${encodeURIComponent(id)}`, {}, { signal }),
    staleTime: 60_000,
  });
}
