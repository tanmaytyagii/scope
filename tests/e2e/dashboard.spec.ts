import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AxeBuilder } from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

/** The fields of an axe-core violation these tests report. */
interface Violation {
  id: string;
  help: string;
  impact?: string | null;
  nodes: Array<{ target: unknown[] }>;
}

/** Fails the test on any console error, e.g. a Content-Security-Policy violation. */
function watchConsole(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  return errors;
}

async function failingTraceId(page: Page): Promise<string> {
  const res = await page.request.get('/api/v1/traces?run=2&eval=failed&limit=1');
  const body = (await res.json()) as { items: Array<{ id: string }> };
  return body.items[0]?.id as string;
}

test('the overview answers how the project is doing', async ({ page }) => {
  const errors = watchConsole(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  await expect(page.getByText('Evaluation pass rate')).toBeVisible();
  const trend = page.getByRole('figure').filter({ hasText: 'Pass rate by run' });
  await expect(trend.getByRole('img')).toBeVisible();
  // Every chart has a table twin with the same values.
  await trend.getByRole('button', { name: 'Table' }).click();
  await expect(trend.getByRole('cell', { name: '#2' })).toBeVisible();
  await expect(trend.getByText('gates failed')).toBeVisible();
  expect(errors).toEqual([]);
});

test('from a failing run to the cause, with the keyboard', async ({ page }) => {
  await page.goto('/runs');
  await page.getByRole('link', { name: '#2', exact: true }).click();
  await expect(page.getByRole('heading', { name: /Run #2/ })).toBeVisible();
  await expect(page.getByText('gates failed').first()).toBeVisible();
  await expect(page.getByText('dropped more than the allowed')).toBeVisible();

  await page.getByText(/^Failed \d+$/).click();
  await expect(page).toHaveURL(/outcome=failed/);
  const firstCase = page.locator('#cases tbody tr').first().getByRole('link');
  await firstCase.click();

  await expect(page.getByText(/evaluation failed/)).toBeVisible();
  const tree = page.getByRole('tree', { name: 'Spans' });
  await tree.getByRole('treeitem').first().focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('tab', { name: 'Documents' })).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('tab', { name: 'Model call' })).toBeVisible();
  await expect(page.getByText('Prompt', { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/span=[0-9a-f]{16}/);

  const failed = page.locator('article').filter({ hasText: 'key_facts' });
  await expect(failed.getByText('failed', { exact: true })).toBeVisible();
  await failed.getByRole('button', { name: 'Show evidence' }).click();
  await expect(failed.getByLabel('Evidence content')).toBeVisible();
});

test('steps through the failing cases of a run and filters the span tree', async ({ page }) => {
  const errors = watchConsole(page);
  const res = await page.request.get('/api/v1/runs/2/cases?limit=200');
  const { items } = (await res.json()) as {
    items: Array<{ caseId: string; traceId: string; outcome: string }>;
  };
  const failing = items.filter((c) => c.outcome !== 'passed');
  expect(failing.length).toBeGreaterThan(1);
  const [first, second] = failing as [(typeof failing)[0], (typeof failing)[0]];

  await page.goto(`/traces/${first.traceId}`);
  const nav = page.getByRole('navigation', { name: 'Failing cases of this run' });
  await expect(nav).toContainText(`Failing case 1 of ${failing.length}`);
  await expect(nav.getByRole('button', { name: 'No previous failing case' })).toBeDisabled();
  await page.keyboard.press(']');
  await expect(page).toHaveURL(new RegExp(`/traces/${second.traceId}$`));
  await expect(nav).toContainText(`Failing case 2 of ${failing.length}`);
  await nav.getByRole('link', { name: `Previous failing case: ${first.caseId}` }).click();
  await expect(page).toHaveURL(new RegExp(`/traces/${first.traceId}$`));

  // Only model calls: each shows under its parents, which stay as context.
  const tree = page.getByRole('tree', { name: 'Spans' });
  const all = await tree.getByRole('treeitem').count();
  await page.getByRole('main').getByText('Model calls', { exact: true }).click();
  await expect(page).toHaveURL(/only=llm/);
  await expect(page.getByText(/^\d+ of \d+ spans match$/)).toBeVisible();
  const shown = await tree.getByRole('treeitem').count();
  expect(shown).toBeLessThan(all);
  await expect(tree.getByRole('treeitem', { name: /, llm,/ }).first()).toBeVisible();

  await page.getByLabel('Filter spans by name, kind or model').fill('no-such-span');
  await expect(page.getByText('No spans match.')).toBeVisible();
  await page.getByRole('button', { name: 'Clear the filter' }).click();
  await expect(page).not.toHaveURL(/only=|q=/);
  await expect(tree.getByRole('treeitem')).toHaveCount(all);
  expect(errors).toEqual([]);
});

test('a run shows what changed against its baseline', async ({ page }) => {
  await page.goto('/runs/2');
  const panel = page.getByRole('region', { name: 'Compared with baseline' });
  await expect(panel).toContainText('baselines/support.json · saved from run #1');
  await expect(panel.getByText(/^[1-9]\d* regressed$/)).toBeVisible();
  const passRate = panel
    .getByRole('row')
    .filter({ has: page.getByText('pass_rate', { exact: true }) });
  await expect(passRate.getByText('worse')).toBeVisible();
  await expect(panel.getByRole('row').filter({ hasText: 'regressed' }).first()).toBeVisible();
  await panel.getByRole('link', { name: 'Compare with run #1' }).click();
  await expect(page).toHaveURL(/\/compare\?base=1&head=2/);

  // A run made without a baseline has nothing to show here.
  await page.goto('/runs/3');
  await expect(page.getByRole('heading', { name: /Run #3/ })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Compared with baseline' })).toHaveCount(0);
});

test('compares two runs case by case', async ({ page }) => {
  await page.goto('/runs');
  await page.getByRole('checkbox', { name: 'Select run #1 to compare' }).check();
  await page.getByRole('checkbox', { name: 'Select run #2 to compare' }).check();
  await page.getByRole('button', { name: /Compare selected/ }).click();
  await expect(page).toHaveURL(/\/compare\?base=1&head=2/);
  await expect(page.getByRole('heading', { name: /Run #1 → run #2/ })).toBeVisible();
  await expect(page.getByText(/\d+ regressed/)).toBeVisible();
  const passRate = page
    .getByRole('row')
    .filter({ has: page.getByText('pass_rate', { exact: true }) });
  await expect(passRate.getByText('worse')).toBeVisible();
});

test('lays three runs side by side', async ({ page }) => {
  await page.goto('/runs');
  for (const n of [1, 2, 3])
    await page.getByRole('checkbox', { name: `Select run #${n} to compare` }).check();
  await page.getByRole('button', { name: 'Compare selected (3)' }).click();
  await expect(page).toHaveURL(/\/compare\?runs=1(%2C|,)2(%2C|,)3$/);
  await expect(page.getByRole('heading', { name: '3 runs side by side' })).toBeVisible();

  // The variants differ in their parameters; the table names them.
  const differs = page.getByRole('region', { name: 'What differs' });
  await expect(differs.getByRole('cell', { name: 'sentences' })).toBeVisible();

  const passRate = page
    .getByRole('region', { name: 'Metrics' })
    .getByRole('row')
    .filter({ has: page.getByText('pass_rate', { exact: true }) });
  await expect(passRate.getByRole('img', { name: 'best' }).first()).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Cases where the runs disagree' }).getByRole('link').first(),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Remove run #3 from the comparison' }).click();
  await expect(page).toHaveURL(/runs=1(%2C|,)2$/);
  await expect(page.getByRole('heading', { name: '2 runs side by side' })).toBeVisible();
});

test('filters live in the URL and survive a reload', async ({ page }) => {
  await page.goto('/traces');
  await page.getByLabel('Evaluation').selectOption('failed');
  await expect(page).toHaveURL(/eval=failed/);
  await page.reload();
  await expect(page.getByLabel('Evaluation')).toHaveValue('failed');
  const results = page.locator('tbody tr');
  await expect(results.first()).toContainText('eval failed');
});

test('the command palette and shortcuts navigate without the mouse', async ({ page }) => {
  await page.goto('/');
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByPlaceholder(/Go to a page/).fill('3');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/runs\/3$/);

  await page.keyboard.press('g');
  await page.keyboard.press('t');
  await expect(page).toHaveURL(/\/traces$/);
  await page.keyboard.press('?');
  await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
});

test('the theme can be chosen and is remembered', async ({ page }) => {
  await page.goto('/settings');
  await page.getByRole('main').getByText('Dark', { exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});

test('a shared server asks for an API key', async ({ page }) => {
  const { readKey } = JSON.parse(readFileSync(join(import.meta.dirname, '.state.json'), 'utf8'));
  await page.goto('http://127.0.0.1:4798/');
  await expect(
    page.getByRole('heading', { name: 'This server requires an API key' }),
  ).toBeVisible();
  await page.getByLabel('API key').fill('scope_not_a_real_key_000000000000');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('alert')).toContainText('invalid or has been revoked');
  await page.getByLabel('API key').fill(readKey);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
});

// One test per page and theme: they run in parallel, and a failure names its page.
test.describe('accessibility', () => {
  const pages: Array<[string, (page: Page) => Promise<string>]> = [
    ['overview', async () => '/'],
    ['runs', async () => '/runs'],
    ['a run', async () => '/runs/2'],
    ['a comparison', async () => '/compare?base=1&head=2'],
    ['runs side by side', async () => '/compare?runs=1,2,3'],
    ['traces', async () => '/traces'],
    ['a trace', async (page) => `/traces/${await failingTraceId(page)}`],
    ['a filtered trace', async (page) => `/traces/${await failingTraceId(page)}?only=llm`],
    ['evaluations', async () => '/evaluations'],
    ['a workflow', async () => '/workflows/support'],
    ['models', async () => '/models'],
    ['settings', async () => '/settings'],
  ];
  for (const theme of ['light', 'dark'] as const) {
    for (const [name, pathOf] of pages) {
      test(`${name} has no serious WCAG A/AA violations (${theme})`, async ({ page }) => {
        await page.emulateMedia({ colorScheme: theme });
        const path = await pathOf(page);
        await page.goto(path);
        await page.waitForLoadState('networkidle');
        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
          .analyze();
        const serious = (results.violations as Violation[])
          .filter((v) => v.impact === 'serious' || v.impact === 'critical')
          .map(
            (v) =>
              `${path}: ${v.id} — ${v.help} (${v.nodes
                .map((n) => n.target.join(' '))
                .slice(0, 3)
                .join(', ')})`,
          );
        expect(serious, path).toEqual([]);
      });
    }
  }
});
