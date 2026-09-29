/**
 * JUnit XML reports, the format GitLab, Jenkins, CircleCI, Azure Pipelines and most other CI
 * systems render natively.
 *
 * One test suite per run: each case is a test case — failed when an evaluator failed, errored
 * when execution failed — so a CI system that compares reports between pipelines (GitLab's
 * merge request widget does) shows exactly which cases started failing. Each run's gates form a
 * second suite: a failed gate is a failed test, a gate skipped for lack of a baseline is skipped,
 * and a failed warning gate passes with the warning as output. Whether the job fails still
 * follows `scope run`'s exit code.
 */
import type { GateResult } from '@scope-ai/core';
import type { Run } from '@scope-ai/storage';

export interface JUnitCase {
  caseId: string;
  outcome: 'passed' | 'failed' | 'errored';
  durationMs: number;
  /** Why the case failed: failed evaluators with their reasons, or the execution error. */
  reasons: string[];
  traceId: string | null;
}

export interface JUnitRun {
  run: Run;
  gates: readonly GateResult[];
  cases: readonly JUnitCase[];
}

/** Escapes text for XML, dropping characters XML 1.0 cannot contain. */
function xml(text: string): string {
  // Lone surrogates become U+FFFD; control characters other than tab and newlines are dropped.
  const wellFormed = (text as { toWellFormed?: () => string }).toWellFormed?.() ?? text;
  return (
    wellFormed
      // biome-ignore lint/suspicious/noControlCharactersInRegex: removing them is the point
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  );
}

const seconds = (ms: number) => (ms / 1000).toFixed(3);

function suiteName(run: Run): string {
  return `${run.workflowName}${run.variant ? ` · ${run.variant}` : ''} (run #${run.number})`;
}

function traceLine(c: JUnitCase, dashboardUrl: string | null): string {
  if (!c.traceId) return '';
  return dashboardUrl
    ? `\nTrace: ${dashboardUrl.replace(/\/$/, '')}/traces/${c.traceId}`
    : `\nTrace: ${c.traceId} (scope traces ${c.traceId.slice(0, 12)})`;
}

export function renderJUnit(runs: readonly JUnitRun[], dashboardUrl: string | null = null): string {
  const lines: string[] = [];
  let tests = 0;
  let failures = 0;
  let errors = 0;
  let time = 0;
  const suites: string[] = [];

  for (const { run, gates, cases } of runs) {
    const classname = `${run.workflowName}${run.variant ? `.${run.variant}` : ''}`;
    const failed = cases.filter((c) => c.outcome === 'failed').length;
    const errored = cases.filter((c) => c.outcome === 'errored').length;
    const duration = (run.durationMs ?? 0) / 1000;
    tests += cases.length;
    failures += failed;
    errors += errored;
    time += duration;
    const suite: string[] = [
      `  <testsuite name="${xml(suiteName(run))}" tests="${cases.length}" failures="${failed}" errors="${errored}" skipped="0" time="${duration.toFixed(3)}" timestamp="${new Date(run.startedAt).toISOString()}">`,
      '    <properties>',
      `      <property name="scope.run" value="${run.number}"/>`,
      `      <property name="scope.run_id" value="${xml(run.id)}"/>`,
      `      <property name="scope.gate_status" value="${run.gateStatus}"/>`,
      ...(run.passRate === null
        ? []
        : [`      <property name="scope.pass_rate" value="${run.passRate.toFixed(4)}"/>`]),
      ...(run.git?.commit
        ? [`      <property name="scope.commit" value="${xml(run.git.commit)}"/>`]
        : []),
      '    </properties>',
    ];
    for (const c of cases) {
      const open = `    <testcase classname="${xml(classname)}" name="${xml(c.caseId)}" time="${seconds(c.durationMs)}"`;
      if (c.outcome === 'passed') {
        suite.push(`${open}/>`);
        continue;
      }
      const tag = c.outcome === 'errored' ? 'error' : 'failure';
      const type = c.outcome === 'errored' ? 'execution' : 'evaluation';
      const detail = `${c.reasons.join('\n')}${traceLine(c, dashboardUrl)}`;
      suite.push(
        `${open}>`,
        `      <${tag} type="${type}" message="${xml(c.reasons[0] ?? c.outcome)}">${xml(detail)}</${tag}>`,
        '    </testcase>',
      );
    }
    suite.push('  </testsuite>');
    suites.push(...suite);

    if (gates.length > 0) {
      const gateFailures = gates.filter((g) => g.status === 'failed' && g.severity === 'fail');
      const skipped = gates.filter((g) => g.status === 'skipped').length;
      tests += gates.length;
      failures += gateFailures.length;
      suites.push(
        `  <testsuite name="${xml(`${suiteName(run)} gates`)}" tests="${gates.length}" failures="${gateFailures.length}" errors="0" skipped="${skipped}" time="0.000">`,
      );
      for (const g of gates) {
        const open = `    <testcase classname="${xml(`${classname}.gates`)}" name="${xml(`${g.metric} ${g.expectation}`)}" time="0.000"`;
        if (g.status === 'passed') suites.push(`${open}/>`);
        else if (g.status === 'skipped')
          suites.push(
            `${open}>`,
            `      <skipped message="${xml(g.message)}"/>`,
            '    </testcase>',
          );
        else if (g.severity === 'warn')
          suites.push(
            `${open}>`,
            `      <system-out>${xml(`warning: ${g.message}`)}</system-out>`,
            '    </testcase>',
          );
        else
          suites.push(
            `${open}>`,
            `      <failure type="gate" message="${xml(g.message)}">${xml(g.message)}</failure>`,
            '    </testcase>',
          );
      }
      suites.push('  </testsuite>');
    }
  }

  lines.push(
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="SCOPE" tests="${tests}" failures="${failures}" errors="${errors}" time="${time.toFixed(3)}">`,
    ...suites,
    '</testsuites>',
  );
  return `${lines.join('\n')}\n`;
}
