import './styles.css';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { ApiError } from './api/client.ts';
import { AuthGate } from './app/Auth.tsx';
import { Layout, RouteError } from './app/Layout.tsx';
import { applyTheme } from './app/theme.ts';
import { Overview } from './pages/Overview.tsx';
import { TooltipProvider } from './ui/Tooltip.tsx';

applyTheme();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      // Client errors (404, 400, 401) will not fix themselves; network blips might.
      retry: (count, error) => !(error instanceof ApiError && error.status >= 400) && count < 2,
    },
  },
});

// The landing page ships in the main bundle; every other page loads on first visit.
const router = createBrowserRouter([
  {
    path: '/',
    element: <Layout />,
    errorElement: <RouteError />,
    children: [
      { index: true, element: <Overview /> },
      { path: 'runs', lazy: () => import('./pages/Runs.tsx').then((m) => ({ Component: m.Runs })) },
      {
        path: 'runs/:run',
        lazy: () => import('./pages/RunDetail.tsx').then((m) => ({ Component: m.RunDetail })),
      },
      {
        path: 'compare',
        lazy: () => import('./pages/Compare.tsx').then((m) => ({ Component: m.Compare })),
      },
      {
        path: 'traces',
        lazy: () => import('./pages/Traces.tsx').then((m) => ({ Component: m.Traces })),
      },
      {
        path: 'traces/:trace',
        lazy: () =>
          import('./pages/trace/TraceExplorer.tsx').then((m) => ({ Component: m.TraceExplorer })),
      },
      {
        path: 'evaluations',
        lazy: () => import('./pages/Evaluations.tsx').then((m) => ({ Component: m.Evaluations })),
      },
      {
        path: 'workflows',
        lazy: () => import('./pages/Workflows.tsx').then((m) => ({ Component: m.Workflows })),
      },
      {
        path: 'workflows/:name',
        lazy: () =>
          import('./pages/WorkflowDetail.tsx').then((m) => ({ Component: m.WorkflowDetail })),
      },
      {
        path: 'models',
        lazy: () => import('./pages/Models.tsx').then((m) => ({ Component: m.Models })),
      },
      {
        path: 'settings',
        lazy: () => import('./pages/Settings.tsx').then((m) => ({ Component: m.Settings })),
      },
      {
        path: '*',
        lazy: () => import('./pages/NotFound.tsx').then((m) => ({ Component: m.NotFound })),
      },
    ],
  },
]);

const root = document.getElementById('root');
if (!root) throw new Error('#root is missing from index.html');

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={300}>
        <AuthGate>
          <RouterProvider router={router} />
        </AuthGate>
      </TooltipProvider>
    </QueryClientProvider>
  </StrictMode>,
);
