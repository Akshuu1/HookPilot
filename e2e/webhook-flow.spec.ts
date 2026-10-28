import { test, expect } from '@playwright/test';
import http from 'node:http';

let destinationServer: http.Server;
let shouldFail = false;
const receivedRequests: Array<{ url?: string; headers: http.IncomingHttpHeaders; body: string }> =
  [];

test.beforeAll(async () => {
  shouldFail = false;
  receivedRequests.length = 0;

  destinationServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      receivedRequests.push({ url: req.url, headers: req.headers, body });
      if (shouldFail) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Simulated destination failure', status: 500 }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: 'Webhook delivered' }));
      }
    });
  });

  await new Promise<void>((resolve) => {
    destinationServer.listen(3999, '127.0.0.1', () => resolve());
  });
});

test.afterAll(async () => {
  if (destinationServer) {
    await new Promise<void>((resolve) => destinationServer.close(() => resolve()));
  }
});

test.describe('End-to-End Webhook Lifecycle Flow', () => {
  test('register -> create workspace & endpoint -> receive -> fail & retry to dead -> replay to delivered', async ({
    page,
    request,
  }) => {
    test.setTimeout(90000);

    const timestamp = Date.now();
    const testEmail = `e2e-user-${timestamp}@test.com`;
    const testPassword = 'Password123!';
    const testWsName = `E2E WS ${timestamp}`;
    const testEndpointName = `E2E Sink ${timestamp}`;

    // ----------------------------------------------------
    // Step 1: User Registration
    // ----------------------------------------------------
    await page.goto('/login');
    await expect(page.locator('h1')).toContainText('HookPilot');

    await page.click('button:has-text("Create Account")');
    await page.fill('input[placeholder="Alex Mercer"]', 'E2E Tester');
    await page.fill('input[type="email"]', testEmail);
    await page.fill('input[type="password"]', testPassword);
    await page.click('button[type="submit"]');

    // Wait for redirect to Endpoints page
    await page.waitForURL('**/endpoints', { timeout: 15000 });
    await expect(page.locator('h2')).toContainText('Webhook Endpoints');

    // ----------------------------------------------------
    // Step 2: Create Workspace
    // ----------------------------------------------------
    const selectWsBtn = page.locator('button:has-text("Select Workspace")');
    await expect(selectWsBtn).toBeVisible({ timeout: 10000 });
    await selectWsBtn.click();

    const createWsDropdownBtn = page.locator('button:has-text("Create Workspace")');
    await expect(createWsDropdownBtn).toBeVisible({ timeout: 5000 });
    await createWsDropdownBtn.click();

    await page.fill('input[placeholder="e.g. Acme Production"]', testWsName);
    await page.click('button[type="submit"]:has-text("Create Workspace")');

    // Verify workspace name is selected in the navbar
    await expect(page.locator(`text=${testWsName}`)).toBeVisible({ timeout: 10000 });

    // ----------------------------------------------------
    // Step 3: Create Webhook Endpoint
    // ----------------------------------------------------
    const createBtn = page
      .locator('button:has-text("New Endpoint"), button:has-text("Create Endpoint")')
      .first();
    await createBtn.click();

    // Verify modal is open
    await expect(page.locator('h3:has-text("Create Webhook Endpoint")')).toBeVisible({
      timeout: 5000,
    });

    await page.fill('input[placeholder="e.g. Stripe Webhook Ingest"]', testEndpointName);
    await page.fill(
      'input[placeholder="https://api.yourdomain.com/webhooks"]',
      'http://127.0.0.1:3999/webhook',
    );

    // Configure fast retry policy (Max Attempts: 2, Base Delay: 100ms)
    const maxAttemptsInput = page
      .locator('label:has-text("Max Attempts")')
      .locator('..')
      .locator('input');
    await maxAttemptsInput.fill('2');

    const baseDelayInput = page
      .locator('label:has-text("Base Delay")')
      .locator('..')
      .locator('input');
    await baseDelayInput.fill('100');

    await page.click('button[type="submit"]:has-text("Create Endpoint")');

    // Wait for modal to close
    await expect(page.locator('h3:has-text("Create Webhook Endpoint")')).not.toBeVisible({
      timeout: 10000,
    });

    // Find the endpoint card on the page by its heading
    const endpointHeading = page.locator('h3', { hasText: testEndpointName });
    await expect(endpointHeading).toBeVisible({ timeout: 10000 });

    const endpointCard = endpointHeading
      .locator('xpath=ancestor::div[contains(@class, "rounded-2xl")]')
      .first();
    await expect(endpointCard).toBeVisible({ timeout: 10000 });

    // Extract endpoint slug from the Ingest URL in the card
    const ingestUrlDiv = endpointCard.locator('div.text-indigo-300').first();
    await expect(ingestUrlDiv).toBeVisible({ timeout: 5000 });
    const ingestUrlText = await ingestUrlDiv.textContent();
    const slug = ingestUrlText?.split('/in/')[1]?.trim();
    expect(slug).toBeDefined();
    expect(slug!.length).toBeGreaterThan(0);

    // ----------------------------------------------------
    // Step 4: Send Webhook via Request API (Destination healthy 200 OK)
    // ----------------------------------------------------
    shouldFail = false;
    const initialPayload = { event: 'order.placed', orderId: `ord-${timestamp}`, amount: 49.99 };

    const sendRes1 = await request.post(`http://localhost:4000/in/${slug}`, {
      data: initialPayload,
      headers: {
        'Content-Type': 'application/json',
        'X-Idempotency-Key': `idem-${timestamp}-1`,
      },
    });

    expect(sendRes1.status()).toBe(202);
    const sendData1 = await sendRes1.json();
    const firstEventId = sendData1.eventId;
    expect(firstEventId).toBeDefined();

    // ----------------------------------------------------
    // Step 5: See Webhook in Event Inspector
    // ----------------------------------------------------
    await page.getByRole('link', { name: 'Event Inspector' }).first().click();
    await expect(page.locator('h2')).toContainText('Event Inspector');

    // Locate event row in virtualized table
    const firstEventRow = page
      .locator('div.cursor-pointer')
      .filter({ hasText: firstEventId })
      .first();
    await expect(firstEventRow).toBeVisible({ timeout: 15000 });

    // Verify status updates live via Socket.IO to "delivered"
    await expect(firstEventRow.locator('text=delivered')).toBeVisible({ timeout: 15000 });

    // Click row to open detail drawer
    await firstEventRow.click();
    await expect(page.locator('button:has-text("Replay Webhook")')).toBeVisible({ timeout: 10000 });

    // Close drawer
    await page.keyboard.press('Escape');

    // ----------------------------------------------------
    // Step 6: Make Destination Fail -> Retries Exhausted -> Dead Letter
    // ----------------------------------------------------
    shouldFail = true;
    const failingPayload = { event: 'payment.failed_test', failId: `fail-${timestamp}` };

    const sendRes2 = await request.post(`http://localhost:4000/in/${slug}`, {
      data: failingPayload,
      headers: {
        'Content-Type': 'application/json',
        'X-Idempotency-Key': `idem-${timestamp}-2`,
      },
    });

    expect(sendRes2.status()).toBe(202);
    const sendData2 = await sendRes2.json();
    const failingEventId = sendData2.eventId;
    expect(failingEventId).toBeDefined();

    const failingEventRow = page
      .locator('div.cursor-pointer')
      .filter({ hasText: failingEventId })
      .first();
    await expect(failingEventRow).toBeVisible({ timeout: 15000 });

    // Wait for retries to exhaust and status badge to become "dead"
    await expect(failingEventRow.locator('text=dead')).toBeVisible({ timeout: 25000 });

    // ----------------------------------------------------
    // Step 7: Replay Webhook with Destination Restored -> Delivered
    // ----------------------------------------------------
    await failingEventRow.click();
    const replayBtn = page.locator('button:has-text("Replay Webhook")');
    await expect(replayBtn).toBeVisible({ timeout: 10000 });

    // Heal destination server to 200 OK
    shouldFail = false;

    // Trigger replay
    await replayBtn.click();

    // Verify status updates live to "delivered"
    await expect(failingEventRow.locator('text=delivered')).toBeVisible({ timeout: 20000 });
  });
});
