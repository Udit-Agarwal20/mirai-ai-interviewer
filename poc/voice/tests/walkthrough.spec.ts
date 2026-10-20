import { test, expect } from '@playwright/test';

test('browser walkthrough of offline demo pipeline', async ({ page }, testInfo) => {
  const screenshotsDir = testInfo.outputPath('screenshots');

  // 1. Navigate to /demo
  await page.goto('http://127.0.0.1:3000/demo');
  await expect(page.getByRole('heading', { name: 'Every question has a source.' })).toBeVisible();
  await page.screenshot({ path: `${screenshotsDir}/walkthrough_1_landing.png` });

  // 2. Create local workspace
  await page.getByRole('button', { name: 'Create local demo workspace', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Backend engineering · HTTP API reliability' })).toBeVisible();
  await page.screenshot({ path: `${screenshotsDir}/walkthrough_2_bank.png` });

  // 3. Approve question bank
  await page.getByRole('button', { name: 'Approve bank v1' }).click();
  await expect(page.getByText('Bank approved. Student interview is now available.')).toBeVisible();
  await page.getByRole('button', { name: 'Continue to student →' }).click();
  await page.screenshot({ path: `${screenshotsDir}/walkthrough_3_student_consent.png` });

  // 4. Student consent and start interview
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Start Interview', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'What does idempotency mean for an HTTP API?' })).toBeVisible();
  await page.screenshot({ path: `${screenshotsDir}/walkthrough_4_turn1.png` });

  await expect(page.getByRole('region', { name: 'Server interview clock' })).toContainText('seconds remaining');

  // 5. Turn 1: Strong answer
  await page.getByRole('button', { name: 'Strong answer', exact: false }).click();
  await expect(page.getByRole('heading', { name: 'How would you handle two simultaneous requests using the same idempotency key?' }).first()).toBeVisible();

  // 6. Turn 2: Strong answer
  await page.getByRole('button', { name: 'Strong answer', exact: false }).click();
  await expect(page.getByText('TURN 2 · SCRIPT')).toBeVisible();

  // 7. End interview
  await page.getByRole('button', { name: 'End Interview', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Interview complete', exact: true })).toBeVisible();
  await expect(page.getByText('Score release to students remains gated.')).toBeVisible();
  await page.screenshot({ path: `${screenshotsDir}/walkthrough_5_student_completed.png` });

  // 8. Open faculty fixture review
  await page.getByRole('button', { name: 'Open faculty fixture review →' }).click();
  await expect(page.getByText('Audio recording: Not available in offline demo')).toBeVisible();

  // Verify scores & arithmetic
  const originalTotal = await page.getByTestId('original-total').innerText();
  const finalTotal = await page.getByTestId('final-total').innerText();
  expect(originalTotal).toBe('70/100');
  expect(finalTotal).toBe('70/100');
  await page.screenshot({ path: `${screenshotsDir}/walkthrough_6_faculty_review.png` });

  // Expand details to inspect provenance and finalized transcript SHA-256
  await page.locator('summary:has-text("Fixture scoring method and limitations")').click();
  await expect(page.getByText('Canonical Finalized Transcript:')).toBeVisible();
  await expect(page.getByText('Evaluator Provenance:')).toBeVisible();
  await page.screenshot({ path: `${screenshotsDir}/walkthrough_7_provenance_details.png` });

  // 9. Faculty override
  await page.getByLabel('New score (0–5)').fill('4');
  await page.getByLabel('Override reason (at least 10 characters)').fill('Faculty reviewed candidate explanations on idempotency keys and adjusted the score.');
  await page.getByRole('button', { name: 'Save override', exact: true }).click();
  await expect(page.getByText('Override saved. Original fixture score preserved.')).toBeVisible();

  // Verify final total updated to 64 and original remained 70
  await expect(page.getByTestId('original-total')).toHaveText('70/100');
  await expect(page.getByTestId('final-total')).toHaveText('64/100');
  await expect(page.getByRole('heading', { name: 'Override history' })).toBeVisible();
  await page.screenshot({ path: `${screenshotsDir}/walkthrough_8_override_saved.png` });
});
