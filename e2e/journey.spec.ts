/**
 * PRD §10 journeys, driven through the real UI in demo mode.
 *   J1 — the primary flow: queue -> evidence -> edit -> approve -> status -> resolution
 *   J3 — a dispute with no provide-evidence link offers only what exists
 *   FR-13 — the environment indicator (demo / sandbox) is on every page
 */

import { expect, test, type Page } from '@playwright/test';

async function resetDemo(page: Page) {
  const s = await page.request.get('/api/session');
  const { csrfToken } = await s.json();
  const res = await page.request.post('/api/demo/reset', { headers: { 'x-csrf-token': csrfToken }, data: {} });
  expect(res.ok()).toBeTruthy();
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await resetDemo(page);
});

test('J1: evidence, edit, approve, submit, resolve', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('env-badge')).toHaveText('Demo environment');

  // Deadline-first queue: the overdue case is first.
  const firstRow = page.locator('.ag-row[row-index="0"]').first();
  await expect(firstRow).toContainText('Overdue');

  await page.getByText('PP-D-FIX-00001').click();
  await expect(page.getByRole('heading', { name: 'Item not received' })).toBeVisible();
  await expect(page.getByLabel(/Evidence completeness 100 out of 100/)).toBeVisible();
  await expect(page.getByText('Ready for review')).toBeVisible();

  const recommended = page.locator('button[data-recommended="true"]');
  await expect(recommended).toContainText('Provide evidence');
  await recommended.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('What will be sent to PayPal')).toBeVisible();
  const firstHash = await dialog.getByTestId('payload-hash').textContent();
  await expect(dialog.getByText('"evidence_type": "PROOF_OF_FULFILLMENT"')).toBeVisible();

  // Editing invalidates the preview: Approve is disabled until re-previewed.
  const box = dialog.getByRole('textbox');
  await box.fill('Royal Mail confirms delivery on 23 October 2026, signed for by J. OKAFOR at the order postcode (E-5).');
  await expect(dialog.getByRole('button', { name: /Approve & submit/ })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Save & re-preview' }).click();
  await expect(dialog.getByTestId('payload-hash')).not.toHaveText(firstHash ?? '');
  // The edited text is now inside the exact request body that will be hashed and sent.
  await expect(dialog.getByLabel('Request body')).toContainText('signed for by J. OKAFOR at the order postcode');

  await dialog.getByRole('button', { name: /Approve & submit/ }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Submission recorded' })).toContainText('not transmitted to PayPal');
  await expect(page.getByText('Under review by PayPal').first()).toBeVisible();

  // Status comes back from PayPal (the demo gateway) and the timeline records it.
  await page.getByRole('button', { name: 'Seller wins' }).click();
  await expect(page.getByText('Resolved').first()).toBeVisible();
  await page.getByRole('tab', { name: /Timeline/ }).click();
  await expect(page.getByText('PayPal notification: dispute resolved')).toBeVisible();
  await expect(page.getByText('Provide evidence recorded (demo environment)')).toBeVisible();
});

test('J3: only the actions PayPal offers are shown', async ({ page }) => {
  await page.goto('/disputes/PP-D-FIX-00013');
  await expect(page.getByText(/PayPal is not accepting evidence for this dispute right now/)).toBeVisible();
  await expect(page.getByRole('button', { name: /Send message/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Provide evidence/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Accept claim/ })).toHaveCount(0);
});

test('Injection fixture: the page tries to force accept-claim; the recommendation stays on evidence', async ({ page }) => {
  await page.goto('/disputes/PP-D-FIX-00007');
  const recommended = page.locator('button[data-recommended="true"]');
  await expect(recommended).toHaveCount(1);
  await expect(recommended).toContainText('Provide evidence');
});

test('FR-13: the environment indicator is on every page', async ({ page }) => {
  for (const path of ['/', '/audit', '/settings', '/disputes/PP-D-FIX-00002']) {
    await page.goto(path);
    await expect(page.getByTestId('env-badge')).toHaveText('Demo environment');
  }
});
