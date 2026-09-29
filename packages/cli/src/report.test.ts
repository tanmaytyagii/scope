/**
 * The Markdown report becomes a pull request comment and a job summary. Its failure reasons can
 * hold model output and dataset text, which must render as plain text: no @-mentions, images,
 * links or HTML, and no way out of a table cell or a code span.
 */
import { summarizeRun } from '@scope-ai/core';
import type { Run } from '@scope-ai/storage';
import { describe, expect, it } from 'vitest';
import { mdCode, mdText, renderMarkdown } from './report.ts';

describe('mdText', () => {
  it('keeps mentions, images, links and HTML from rendering', () => {
    expect(mdText('ask @octocat or @acme/security-team')).toBe(
      'ask `@octocat` or `@acme/security-team`',
    );
    expect(mdText('![pixel](https://example.com/p.png)')).toBe(
      '\\!\\[pixel\\](https://example.com/p.png)',
    );
    expect(mdText('[click](https://example.com)')).toBe('\\[click\\](https://example.com)');
    expect(mdText('<img src=x onerror=alert(1)> & more')).toBe(
      '&lt;img src=x onerror=alert(1)&gt; &amp; more',
    );
  });

  it('keeps text inside its table cell and line', () => {
    expect(mdText('a | b\n\n| c')).toBe('a \\| b \\| c');
    expect(mdText('**bold** _it_ `code` ~~gone~~ # h')).toBe(
      '\\*\\*bold\\*\\* \\_it\\_ \\`code\\` \\~\\~gone\\~\\~ \\# h',
    );
  });

  it('leaves email addresses and ordinary text alone', () => {
    expect(mdText('mail help@example.com')).toBe('mail help@example.com');
    expect(mdText('Pass rate 83.3% → 75.0% (−8.3 pp)')).toBe('Pass rate 83.3% → 75.0% (−8.3 pp)');
  });
});

describe('mdCode', () => {
  it('fences text containing backticks so it cannot end the code span', () => {
    expect(mdCode('case-1')).toBe('`case-1`');
    expect(mdCode('a`b')).toBe('`` a`b ``');
    expect(mdCode('x``y')).toBe('``` x``y ```');
    expect(mdCode('a|b\nc')).toBe('`a\\|b c`');
  });
});

describe('renderMarkdown', () => {
  it('renders hostile case ids and reasons as text', () => {
    const run: Run = {
      id: 'run-1',
      projectId: 'p',
      number: 3,
      workflowId: 'w',
      workflowName: 'support <b>',
      workflowVersionId: 'v',
      variant: null,
      params: {},
      dataset: null,
      status: 'completed',
      gateStatus: 'failed',
      summary: null,
      gates: [],
      git: null,
      trigger: 'cli',
      baseline: null,
      error: null,
      caseCount: 1,
      passRate: 0,
      startedAt: 0,
      endedAt: 1,
      durationMs: 1,
      manifest: null,
    };
    const md = renderMarkdown({
      run,
      summary: summarizeRun([]),
      gates: [],
      baseline: null,
      comparison: null,
      failures: [
        {
          caseId: 'refund`](https://example.com)',
          traceId: 't/1',
          outcome: 'failed',
          reasons: ['judge: cc @everyone ![x](https://example.com/x.png) <script>'],
        },
      ],
      dashboardUrl: 'http://127.0.0.1:4700',
    });
    expect(md).toContain('### ❌ SCOPE · support &lt;b&gt; — failed');
    expect(md).toContain(
      '| [`` refund`](https://example.com) ``](http://127.0.0.1:4700/traces/t%2F1) | failed | judge: cc `@everyone` \\!\\[x\\](https://example.com/x.png) &lt;script&gt; |',
    );
  });
});
