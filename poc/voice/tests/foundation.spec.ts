import { expect, test, type Page } from "@playwright/test";

// These are interface simulations, not real microphones or provider integrations.
async function simulateMicrophone(page: Page, mode: "success" | "denied" | "missing" | "busy" | "delayed") {
  await page.addInitScript((mode) => {
    const state = { calls: 0, stops: 0, release: () => {} };
    Object.assign(window, { micSimulation: state });
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      value: async () => {
        state.calls += 1;
        if (mode === "denied") throw new DOMException("simulated", "NotAllowedError");
        if (mode === "missing") throw new DOMException("simulated", "NotFoundError");
        if (mode === "busy") throw new DOMException("simulated", "NotReadableError");
        if (mode === "delayed") await new Promise<void>((resolve) => { state.release = resolve; });
        const track = { stop: () => { state.stops += 1; }, onended: null };
        return { getTracks: () => [track], getAudioTracks: () => [track] };
      }
    });
  }, mode);
}

async function microphoneCounts(page: Page) {
  return page.evaluate(() => {
    const state = (window as unknown as { micSimulation: { calls: number; stops: number } }).micSimulation;
    return { calls: state.calls, stops: state.stops };
  });
}

test("consent alone never captures; explicit check starts and withdrawal stops", async ({ page }) => {
  await simulateMicrophone(page, "success");
  await page.goto("/");
  const check = page.getByRole("button", { name: "Check microphone" });
  await expect(check).toBeDisabled();
  expect(await microphoneCounts(page)).toEqual({ calls: 0, stops: 0 });
  await page.getByRole("checkbox").first().check();
  expect(await microphoneCounts(page)).toEqual({ calls: 0, stops: 0 });
  await check.click();
  await expect(page.getByTestId("microphone-status")).toContainText("access granted");
  await page.getByRole("checkbox").first().uncheck();
  expect(await microphoneCounts(page)).toEqual({ calls: 1, stops: 1 });
  await expect(check).toBeDisabled();
});

for (const [mode, message] of [["denied", "permission denied"], ["missing", "No microphone found"], ["busy", "Microphone unavailable"]] as const) {
  test(`simulated ${mode} gives a recoverable error`, async ({ page }) => {
    await simulateMicrophone(page, mode);
    await page.goto("/");
    await page.getByRole("checkbox").first().check();
    await page.getByRole("button", { name: "Check microphone" }).click();
    await expect(page.getByTestId("microphone-status")).toContainText(message);
    await expect(page.getByRole("button", { name: "Check microphone" })).toBeEnabled();
  });
}

test("late permission after cancellation immediately stops the acquired track", async ({ page }) => {
  await simulateMicrophone(page, "delayed");
  await page.goto("/");
  await page.getByRole("checkbox").first().check();
  await page.getByRole("button", { name: "Check microphone" }).click();
  await page.getByRole("button", { name: "Cancel check" }).click();
  await page.evaluate(() => (window as unknown as { micSimulation: { release: () => void } }).micSimulation.release());
  await expect.poll(() => microphoneCounts(page)).toEqual({ calls: 1, stops: 1 });
  await expect(page.getByTestId("microphone-status")).toContainText("Microphone stopped");
});

test("late permission after consent withdrawal cannot reactivate capture", async ({ page }) => {
  await simulateMicrophone(page, "delayed");
  await page.goto("/");
  await page.getByRole("checkbox").first().check();
  await page.getByRole("button", { name: "Check microphone" }).click();
  await page.getByRole("checkbox").first().uncheck();
  await page.evaluate(() => (window as unknown as { micSimulation: { release: () => void } }).micSimulation.release());
  await expect.poll(() => microphoneCounts(page)).toEqual({ calls: 1, stops: 1 });
  await expect(page.getByTestId("microphone-status")).toContainText("Consent withdrawn");
});

test("automatic timeout releases the microphone", async ({ page }) => {
  await page.clock.install();
  await simulateMicrophone(page, "success");
  await page.goto("/");
  await page.getByRole("checkbox").first().check();
  await page.getByRole("button", { name: "Check microphone" }).click();
  await expect(page.getByTestId("microphone-status")).toContainText("access granted");
  await page.clock.fastForward(10_001);
  await expect(page.getByTestId("microphone-status")).toContainText("10-second check finished");
  expect(await microphoneCounts(page)).toEqual({ calls: 1, stops: 1 });
});

test("pagehide releases active capture", async ({ page }) => {
  await simulateMicrophone(page, "success");
  await page.goto("/");
  await page.getByRole("checkbox").first().check();
  await page.getByRole("button", { name: "Check microphone" }).click();
  await expect(page.getByTestId("microphone-status")).toContainText("access granted");
  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  expect(await microphoneCounts(page)).toEqual({ calls: 1, stops: 1 });
});

test("unsupported browser explains missing media API", async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, "mediaDevices", { value: undefined }));
  await page.goto("/");
  await page.getByRole("checkbox").first().check();
  await page.getByRole("button", { name: "Check microphone" }).click();
  await expect(page.getByTestId("microphone-status")).toContainText("unsupported");
});

test("real browser media API with synthetic device starts and stops, without external requests", async ({ page, context }) => {
  await context.grantPermissions(["microphone"]);
  const external: string[] = [];
  await context.route("**/*", (route) => {
    if (new URL(route.request().url()).origin !== "http://127.0.0.1:3000") {
      external.push(route.request().url());
      return route.abort();
    }
    return route.continue();
  });
  await page.goto("/");
  await page.getByRole("checkbox").first().check();
  await page.getByRole("button", { name: "Check microphone" }).click();
  await expect(page.getByTestId("microphone-status")).toContainText("access granted", { timeout: 15_000 });
  await page.getByRole("button", { name: "Stop microphone" }).click();
  await expect(page.getByTestId("microphone-status")).toContainText("Microphone stopped");
  expect(external).toEqual([]);
});

test("local health reports missing names, never secrets or an enabled connection", async ({ page, request }) => {
  const response = await request.get("/api/poc/health");
  expect(response.ok()).toBeTruthy();
  expect(response.headers()["cache-control"]).toBe("no-store");
  const text = await response.text();
  expect(text).not.toContain("synthetic-server-only-sentinel");
  const report = JSON.parse(text);
  expect(report.liveConnectionsEnabled).toBe(false);
  expect(report.providers[0].missing).toEqual(["LIVEKIT_URL", "LIVEKIT_API_KEY"]);
  await page.goto("/");
  await expect(page.getByText("Separate approval required for live services")).toBeVisible();
  await expect(page.getByText("Missing:", { exact: false }).first()).toBeVisible();
  expect(await page.content()).not.toContain("synthetic-server-only-sentinel");
});

test("failed local health does not suggest providers are connected", async ({ page }) => {
  await page.route("**/api/poc/health", (route) => route.fulfill({ status: 503, body: "unavailable" }));
  await page.goto("/");
  await expect(page.getByRole("alert").filter({ hasText: "Local setup check unavailable" })).toBeVisible();
  await expect(page.getByText("Separate approval required for live services")).toBeVisible();
});
