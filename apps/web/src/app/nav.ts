import type { ComponentType } from 'react';
import {
  IconEvaluations,
  IconModels,
  IconOverview,
  IconRuns,
  IconSettings,
  IconTraces,
  IconWorkflows,
} from '../ui/icons.tsx';

export interface NavItem {
  to: string;
  label: string;
  /** Second key of the "g <key>" shortcut. */
  key: string;
  icon: ComponentType<{ size?: number }>;
  description: string;
}

export const NAV: readonly NavItem[] = [
  {
    to: '/',
    label: 'Overview',
    key: 'o',
    icon: IconOverview,
    description: 'How the system is doing',
  },
  {
    to: '/runs',
    label: 'Runs',
    key: 'r',
    icon: IconRuns,
    description: 'Workflow runs, gates and comparisons',
  },
  {
    to: '/traces',
    label: 'Traces',
    key: 't',
    icon: IconTraces,
    description: 'Every execution, step by step',
  },
  {
    to: '/evaluations',
    label: 'Evaluations',
    key: 'e',
    icon: IconEvaluations,
    description: 'Evaluator health and failures',
  },
  {
    to: '/workflows',
    label: 'Workflows',
    key: 'w',
    icon: IconWorkflows,
    description: 'Definitions, versions and history',
  },
  {
    to: '/models',
    label: 'Models',
    key: 'm',
    icon: IconModels,
    description: 'Calls, latency and cost per model',
  },
  {
    to: '/settings',
    label: 'Settings',
    key: 's',
    icon: IconSettings,
    description: 'Project, storage, privacy and pricing',
  },
];
