import { expect, test } from '@playwright/test';

test('creates a schedule event with a mode and edits it', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('onboarding-demo').tap();
  await page.getByTestId('calibration-save').tap();
  await page.getByTestId('tab-schedule').tap();
  await expect(page.getByText('Schedule', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Add event' }).tap();
  const custom = page.locator('[data-testid^="event-"]').filter({ hasText: 'Custom' });
  await custom.getByText('Custom', { exact: true }).tap();

  await expect(page.getByTestId('mode-keep')).toBeVisible();
  await page.getByTestId('mode-heat').tap();
  await page.getByTestId('save-event').scrollIntoViewIfNeeded();
  await page.screenshot({ path: '/opt/cursor/artifacts/schedule-editor-heat.png', fullPage: false });
  await page.getByTestId('save-event').tap();

  await expect(custom.getByText(/Heat/)).toBeVisible();
  await page.screenshot({ path: '/opt/cursor/artifacts/schedule-list-heat.png', fullPage: true });

  await custom.getByText('Custom', { exact: true }).tap();
  await page.getByTestId('mode-cool').tap();
  await page.getByTestId('save-event').scrollIntoViewIfNeeded();
  await page.getByTestId('save-event').tap();
  await expect(custom.getByText(/Cool/)).toBeVisible();

  const saved = await page.evaluate(() => window.localStorage.getItem('setpoint.state.v1'));
  expect(saved).toBeTruthy();
  const state = JSON.parse(saved ?? '{}') as { events: { label: string; mode?: string }[] };
  expect(state.events.find((event) => event.label === 'Custom')?.mode).toBe('cool');
  expect(state.events.find((event) => event.label === 'Wake')?.mode).toBeUndefined();
});
