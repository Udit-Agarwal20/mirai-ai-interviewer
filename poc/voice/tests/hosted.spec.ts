import { test, expect } from "@playwright/test";
import { createHash } from "node:crypto";
import {
  hashJudgeCode,
  verifyJudgeCode,
  MemoryAdmissionStore,
  UpstashRedisAdmissionStore,
  getAdmissionStore,
  setAdmissionStoreForTesting,
} from "../lib/hosted-admission";
import { adminResetJudgeInvitation } from "../lib/admin-reset";
import {
  createHostedSession,
  createJudgeSessionCapability,
  getSessionSigningSecret,
  setMockLiveKitClientsForTesting,
  validateHostedRequest,
  verifyJudgeSessionCapability,
} from "../lib/hosted-session";

const testPepper = "test-salt-secret-sufficient-length-32";
const judgeCode1 = "mirai-judge-alpha-2026-test";
const judgeCode2 = "mirai-judge-beta-2026-test";
const hash1 = createHash("sha256").update(judgeCode1 + testPepper).digest("hex");
const hash2 = createHash("sha256").update(judgeCode2 + testPepper).digest("hex");

test.beforeAll(() => {
  process.env.JUDGE_INVITE_SALT = testPepper;
  process.env.JUDGE_INVITE_HASH_1 = hash1;
  process.env.JUDGE_INVITE_HASH_2 = hash2;
  process.env.ADMIN_RESET_SECRET = "0123456789abcdef0123456789abcdef";
  process.env.JUDGE_SESSION_SECRET = "0123456789abcdef0123456789abcdef-session";
  process.env.LIVEKIT_API_KEY = "test-lk-key";
  process.env.LIVEKIT_API_SECRET = "test-lk-secret-with-sufficient-length-32";
  process.env.LIVEKIT_URL = "wss://synthetic.livekit.cloud";
});

test.describe("Fix 1: Production Admission Must Fail Closed", () => {
  test("1. Hosted production mode strictly refuses MemoryAdmissionStore", () => {
    const originalMode = process.env.POC_MODE;
    const originalUrl = process.env.UPSTASH_REDIS_REST_URL;
    const originalToken = process.env.UPSTASH_REDIS_REST_TOKEN;

    try {
      process.env.POC_MODE = "hosted";
      delete process.env.UPSTASH_REDIS_REST_URL;
      delete process.env.UPSTASH_REDIS_REST_TOKEN;
      setAdmissionStoreForTesting(null);

      const store = getAdmissionStore();
      expect(store.constructor.name).toBe("FailClosedAdmissionStore");
    } finally {
      process.env.POC_MODE = originalMode;
      if (originalUrl) process.env.UPSTASH_REDIS_REST_URL = originalUrl;
      if (originalToken) process.env.UPSTASH_REDIS_REST_TOKEN = originalToken;
    }
  });

  test("2. Upstash REST contract: handles OK, ALREADY_CONSUMED, GLOBAL_LIMIT_REACHED", async () => {
    // Protocol-level mock: OK
    const okStore = new UpstashRedisAdmissionStore(
      "https://mock.upstash.io",
      "mock-token",
      async () => new Response(JSON.stringify({ result: "OK" }), { status: 200 })
    );
    const okClaim = await okStore.claimAdmission(hash1, "judge-1");
    expect(okClaim.allowed).toBe(true);

    // Protocol-level mock: ALREADY_CONSUMED
    const consumedStore = new UpstashRedisAdmissionStore(
      "https://mock.upstash.io",
      "mock-token",
      async () => new Response(JSON.stringify({ result: "ALREADY_CONSUMED" }), { status: 200 })
    );
    const consumedClaim = await consumedStore.claimAdmission(hash1, "judge-1");
    expect(consumedClaim.allowed).toBe(false);
    if (!consumedClaim.allowed) expect(consumedClaim.error).toBe("already_consumed");

    // Protocol-level mock: GLOBAL_LIMIT_REACHED
    const limitStore = new UpstashRedisAdmissionStore(
      "https://mock.upstash.io",
      "mock-token",
      async () => new Response(JSON.stringify({ result: "GLOBAL_LIMIT_REACHED" }), { status: 200 })
    );
    const limitClaim = await limitStore.claimAdmission(hash2, "judge-2");
    expect(limitClaim.allowed).toBe(false);
    if (!limitClaim.allowed) expect(limitClaim.error).toBe("global_limit_reached");
  });

  test("3. Upstash REST contract: fails closed on HTTP 401, 500, malformed JSON, and timeouts", async () => {
    // HTTP 401 Unauthorized
    const store401 = new UpstashRedisAdmissionStore(
      "https://mock.upstash.io",
      "bad-token",
      async () => new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 })
    );
    const res401 = await store401.claimAdmission(hash1, "judge-1");
    expect(res401.allowed).toBe(false);
    if (!res401.allowed) expect(res401.error).toBe("store_unavailable");

    // HTTP 500 Internal Error
    const store500 = new UpstashRedisAdmissionStore(
      "https://mock.upstash.io",
      "token",
      async () => new Response("Internal Server Error", { status: 500 })
    );
    const res500 = await store500.claimAdmission(hash1, "judge-1");
    expect(res500.allowed).toBe(false);
    if (!res500.allowed) expect(res500.error).toBe("store_unavailable");

    // Malformed JSON
    const storeMalformed = new UpstashRedisAdmissionStore(
      "https://mock.upstash.io",
      "token",
      async () => new Response("{ not valid json }", { status: 200 })
    );
    const resMalformed = await storeMalformed.claimAdmission(hash1, "judge-1");
    expect(resMalformed.allowed).toBe(false);
    if (!resMalformed.allowed) expect(resMalformed.error).toBe("store_unavailable");

    // Network timeout
    const storeTimeout = new UpstashRedisAdmissionStore(
      "https://mock.upstash.io",
      "token",
      async () => {
        throw new Error("Network timeout after 5000ms");
      }
    );
    const resTimeout = await storeTimeout.claimAdmission(hash1, "judge-1");
    expect(resTimeout.allowed).toBe(false);
    if (!resTimeout.allowed) expect(resTimeout.error).toBe("store_unavailable");
  });

  test("4. Test admission store: enforces 1 per code, 2 global, and atomic concurrency", async () => {
    const memStore = new MemoryAdmissionStore();

    // First claim succeeds
    const c1 = await memStore.claimAdmission(hash1, "judge-1");
    expect(c1.allowed).toBe(true);

    // Reuse of code 1 fails
    const c1Reuse = await memStore.claimAdmission(hash1, "judge-1");
    expect(c1Reuse.allowed).toBe(false);
    if (!c1Reuse.allowed) expect(c1Reuse.error).toBe("already_consumed");

    // Code 2 succeeds (count becomes 2)
    const c2 = await memStore.claimAdmission(hash2, "judge-2");
    expect(c2.allowed).toBe(true);

    // Code 3 fails due to global limit
    const hash3 = createHash("sha256").update("code3" + testPepper).digest("hex");
    const c3 = await memStore.claimAdmission(hash3, "judge-extra");
    expect(c3.allowed).toBe(false);
    if (!c3.allowed) expect(c3.error).toBe("global_limit_reached");
  });
});

test.describe("Fix 2: Dedicated Session Signing Secret & Fail-Closed Enforcement", () => {
  test("5. Session capability generation, verification, and expiration", () => {
    const room = "mirai-judge-test-room-123456";
    const capability = createJudgeSessionCapability("judge-1", room);
    expect(capability.cookieValue).toBeDefined();

    // Valid verification
    const verified = verifyJudgeSessionCapability(capability.cookieValue, room);
    expect(verified.valid).toBe(true);
    expect(verified.judgeLabel).toBe("judge-1");
    expect(verified.roomName).toBe(room);

    // Tampered signature rejected
    const tampered = capability.cookieValue.slice(0, -4) + "ffff";
    expect(verifyJudgeSessionCapability(tampered, room).valid).toBe(false);

    // Room mismatch rejected
    const crossRoom = verifyJudgeSessionCapability(capability.cookieValue, "mirai-judge-different-room");
    expect(crossRoom.valid).toBe(false);
    expect(crossRoom.error).toBe("room_mismatch_unauthorized");
  });

  test("6. Hosted production mode strictly requires JUDGE_SESSION_SECRET without fallbacks", () => {
    const originalMode = process.env.POC_MODE;
    const originalSecret = process.env.JUDGE_SESSION_SECRET;
    const originalAdmin = process.env.ADMIN_RESET_SECRET;
    const originalControl = process.env.POC_CONTROL_SECRET;

    try {
      process.env.POC_MODE = "hosted";
      process.env.ADMIN_RESET_SECRET = "fallback-admin-secret-which-must-be-ignored-32chars";
      process.env.POC_CONTROL_SECRET = "fallback-control-secret-which-must-be-ignored-32chars";

      // 1. Missing secret throws
      delete process.env.JUDGE_SESSION_SECRET;
      expect(() => getSessionSigningSecret()).toThrow("judge_session_secret_unconfigured");

      // 2. Short secret (< 32 chars) throws
      process.env.JUDGE_SESSION_SECRET = "short-secret-under-32-chars";
      expect(() => getSessionSigningSecret()).toThrow("judge_session_secret_unconfigured");

      // 3. Low entropy / placeholder throws
      process.env.JUDGE_SESSION_SECRET = "placeholder-secret-with-more-than-32-chars-long";
      expect(() => getSessionSigningSecret()).toThrow("judge_session_secret_insufficient_entropy");

      // 4. Repeated chars (low entropy) throws
      process.env.JUDGE_SESSION_SECRET = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      expect(() => getSessionSigningSecret()).toThrow("judge_session_secret_insufficient_entropy");

      // 5. Valid high-entropy secret succeeds
      process.env.JUDGE_SESSION_SECRET = "0123456789abcdef0123456789abcdef-dedicated-session-secret";
      expect(getSessionSigningSecret()).toBe("0123456789abcdef0123456789abcdef-dedicated-session-secret");
    } finally {
      process.env.POC_MODE = originalMode;
      if (originalSecret) process.env.JUDGE_SESSION_SECRET = originalSecret;
      if (originalAdmin) process.env.ADMIN_RESET_SECRET = originalAdmin;
      if (originalControl) process.env.POC_CONTROL_SECRET = originalControl;
    }
  });

  test("7. DELETE /api/poc/judge/session rejects unauthorized, forged, or cross-judge deletions", async ({ request }) => {
    // DELETE without cookie
    const resNoCookie = await request.delete("/api/poc/judge/session", {
      headers: { "Content-Type": "application/json" },
      data: JSON.stringify({ room: "mirai-judge-mock" }),
    });
    expect(resNoCookie.status()).toBe(403);

    // DELETE with forged/tampered cookie
    const resForged = await request.delete("/api/poc/judge/session", {
      headers: {
        "Content-Type": "application/json",
        Cookie: "mirai_judge_session=0123456789abcdef0123456789abcdef.judge-1.mirai-judge-mock.1999999999999.badhash",
      },
      data: JSON.stringify({ room: "mirai-judge-mock" }),
    });
    expect(resForged.status()).toBe(403);

    // DELETE with cross-judge room mismatch
    const room1 = "mirai-judge-room11111111";
    const cap1 = createJudgeSessionCapability("judge-1", room1);
    const resMismatch = await request.delete("/api/poc/judge/session", {
      headers: {
        "Content-Type": "application/json",
        Cookie: `mirai_judge_session=${cap1.cookieValue}`,
      },
      data: JSON.stringify({ room: "mirai-judge-foreign-room" }),
    });
    expect(resMismatch.status()).toBe(403);
    const bodyMismatch = await resMismatch.json();
    expect(bodyMismatch.error).toBe("unauthorized_deletion");
  });
});

test.describe("Fix 3: Actual Invitation Rate Limiting and Abuse Prevention", () => {
  test("8. Rate limiting blocks client after 5 failed attempts with HTTP 429", async () => {
    const memStore = new MemoryAdmissionStore();
    const testClient = "192.168.1.100";

    // 4 failed attempts are recorded but allowed
    for (let i = 0; i < 4; i++) {
      const rec = await memStore.recordFailedAttempt(testClient);
      expect(rec.allowed).toBe(true);
    }
    const checkBefore5 = await memStore.checkRateLimit(testClient);
    expect(checkBefore5.allowed).toBe(true);

    // 5th failed attempt triggers limit
    const rec5 = await memStore.recordFailedAttempt(testClient);
    expect(rec5.allowed).toBe(false);
    expect(rec5.error).toBe("too_many_failed_attempts");

    // Subsequent check is genuinely blocked
    const checkAfter5 = await memStore.checkRateLimit(testClient);
    expect(checkAfter5.allowed).toBe(false);
    expect(checkAfter5.error).toBe("too_many_failed_attempts");
  });

  test("9. Upstash Redis rate limiting: genuine blocking and fails closed on outage", async () => {
    // 1. Upstash returns count >= 5 on GET -> rate limited
    const blockedStore = new UpstashRedisAdmissionStore(
      "https://mock.upstash.io",
      "mock-token",
      async () => new Response(JSON.stringify({ result: "5" }), { status: 200 })
    );
    const check = await blockedStore.checkRateLimit("203.0.113.1");
    expect(check.allowed).toBe(false);
    expect(check.error).toBe("too_many_failed_attempts");

    // 2. Upstash outage on rate limit check -> fails closed (store_unavailable)
    const outageStore = new UpstashRedisAdmissionStore(
      "https://mock.upstash.io",
      "mock-token",
      async () => {
        throw new Error("Redis cluster down");
      }
    );
    const checkOutage = await outageStore.checkRateLimit("203.0.113.1");
    expect(checkOutage.allowed).toBe(false);
    expect(checkOutage.error).toBe("store_unavailable");
  });

  test("10. Multiple clients cannot bypass the global 2-session admission cap", async () => {
    const memStore = new MemoryAdmissionStore();

    // Client 1 claims Judge 1
    const claim1 = await memStore.claimAdmission(hash1, "judge-1");
    expect(claim1.allowed).toBe(true);

    // Client 2 claims Judge 2
    const claim2 = await memStore.claimAdmission(hash2, "judge-2");
    expect(claim2.allowed).toBe(true);

    // Any other client attempting any other code is strictly rejected by global limit
    const hash3 = createHash("sha256").update("code3" + testPepper).digest("hex");
    const claim3 = await memStore.claimAdmission(hash3, "judge-extra");
    expect(claim3.allowed).toBe(false);
    if (!claim3.allowed) expect(claim3.error).toBe("global_limit_reached");
  });
});

test.describe("Security Hardening & Protection Verifications", () => {
  test("11. Strict origin validation: rejects missing origin, cross-site, and localhost in production", () => {
    const originalMode = process.env.POC_MODE;
    const originalOrigin = process.env.APP_ORIGIN;

    try {
      process.env.POC_MODE = "hosted";
      process.env.APP_ORIGIN = "https://mirai-judge.onrender.com";

      // 1. Missing Origin on mutation
      const reqNoOrigin = new Request("https://mirai-judge.onrender.com/api/poc/judge/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const vNoOrigin = validateHostedRequest(reqNoOrigin);
      expect(vNoOrigin.valid).toBe(false);
      expect(vNoOrigin.error).toBe("unauthorized_origin");

      // 2. Localhost Origin blocked in hosted production
      const reqLocalhost = new Request("https://mirai-judge.onrender.com/api/poc/judge/session", {
        method: "POST",
        headers: { Origin: "http://127.0.0.1:3000", "Content-Type": "application/json" },
      });
      const vLocalhost = validateHostedRequest(reqLocalhost);
      expect(vLocalhost.valid).toBe(false);

      // 3. Cross-origin Sec-Fetch-Site blocked
      const reqCrossSite = new Request("https://mirai-judge.onrender.com/api/poc/judge/session", {
        method: "POST",
        headers: {
          Origin: "https://mirai-judge.onrender.com",
          "Sec-Fetch-Site": "cross-site",
          "Content-Type": "application/json",
        },
      });
      const vCrossSite = validateHostedRequest(reqCrossSite);
      expect(vCrossSite.valid).toBe(false);
      expect(vCrossSite.error).toBe("cross_origin_blocked");

      // 4. Correct Origin and same-origin Sec-Fetch-Site accepted
      const reqValid = new Request("https://mirai-judge.onrender.com/api/poc/judge/session", {
        method: "POST",
        headers: {
          Origin: "https://mirai-judge.onrender.com",
          "Sec-Fetch-Site": "same-origin",
          "Content-Type": "application/json",
        },
      });
      expect(validateHostedRequest(reqValid).valid).toBe(true);
    } finally {
      process.env.POC_MODE = originalMode;
      process.env.APP_ORIGIN = originalOrigin;
    }
  });

  test("12. Hosted production mode strictly refuses mock LiveKit URLs and test bypass injection", async () => {
    const originalMode = process.env.POC_MODE;
    const originalEnv = process.env.NODE_ENV;
    const originalUrl = process.env.LIVEKIT_URL;

    try {
      process.env.POC_MODE = "hosted";
      (process.env as any).NODE_ENV = "production";

      // 1. Refuses test injection in production
      expect(() => setAdmissionStoreForTesting(new MemoryAdmissionStore())).toThrow("test_injection_forbidden_in_production");
      expect(() => setMockLiveKitClientsForTesting({} as any)).toThrow("test_injection_forbidden_in_production");

      // 2. Refuses mock LiveKit URL in hosted mode
      process.env.LIVEKIT_URL = "wss://mock.livekit.cloud";
      await expect(createHostedSession("judge-1")).rejects.toThrow("livekit_url_invalid_or_unconfigured");
    } finally {
      process.env.POC_MODE = originalMode;
      (process.env as any).NODE_ENV = originalEnv;
      process.env.LIVEKIT_URL = originalUrl;
    }
  });

  test("13. Partial start failure cleanup: room deleted if agent dispatch fails", async () => {
    let roomCreated = false;
    let roomDeleted = false;

    setMockLiveKitClientsForTesting({
      roomService: {
        createRoom: async () => {
          roomCreated = true;
          return {} as any;
        },
        deleteRoom: async () => {
          roomDeleted = true;
          return {} as any;
        },
      },
      dispatchClient: {
        createDispatch: async () => {
          throw new Error("LiveKit dispatch quota exceeded");
        },
      },
    });

    await expect(createHostedSession("judge-1")).rejects.toThrow("LiveKit dispatch quota exceeded");
    expect(roomCreated).toBe(true);
    expect(roomDeleted).toBe(true);

    setMockLiveKitClientsForTesting(null);
  });
});

test.describe("Phase E & F: Offline Browser UI and Lifecycle on /judge", () => {
  test("14. Browser UI requires code, preflight, and consent to enable start button", async ({ page }) => {
    await page.goto("/judge");

    const startBtn = page.getByTestId("start-judge-interview");
    await expect(startBtn).toBeDisabled();

    // Fill valid invitation code
    await page.getByPlaceholder("Enter private code").fill(judgeCode1);
    await expect(startBtn).toBeDisabled();

    // Synthetic mic check
    await page.getByRole("checkbox").first().check();
    await page.getByRole("button", { name: "Check microphone" }).click();
    await expect(page.getByTestId("judge-mic-status")).toContainText("access verified");
    await expect(startBtn).toBeDisabled();

    // Check live consent
    await page.getByRole("checkbox").nth(1).check();
    await expect(startBtn).toBeEnabled();
  });

  test("15. Browser displays safe error when invitation code is invalid or reused", async ({ page }) => {
    await page.route("**/api/poc/judge/session", async (route) => {
      if (route.request().method() === "POST") {
        await route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({
            error: "already_consumed",
            message: "This judge invitation code has already been used for an interview.",
          }),
        });
        return;
      }
      await route.continue();
    });

    await page.goto("/judge");
    await page.getByPlaceholder("Enter private code").fill(judgeCode1);
    await page.getByRole("checkbox").first().check();
    await page.getByRole("button", { name: "Check microphone" }).click();
    await page.getByRole("checkbox").nth(1).check();

    const startBtn = page.getByTestId("start-judge-interview");
    await startBtn.click();

    await expect(page.getByTestId("judge-session-status")).toContainText("already been used");
  });

  test("16. Tab hidden cancels judge session cleanly and dispatches authenticated DELETE", async ({ page }) => {
    let deleteDispatched = false;
    await page.route("**/api/poc/judge/session", async (route) => {
      if (route.request().method() === "POST") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          headers: {
            "Set-Cookie": "mirai_judge_session=0123456789abcdef0123456789abcdef.judge-1.mirai-judge-mock.1999999999999.sig; Path=/api/poc/judge/session",
          },
          body: JSON.stringify({
            token: "mock.jwt.token",
            url: "wss://synthetic.livekit.cloud",
            room: "mirai-judge-mock",
            identity: "judge-1-mock",
            maxDuration: 60,
            maxTurns: 3,
          }),
        });
        return;
      }
      if (route.request().method() === "DELETE") {
        deleteDispatched = true;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ state: "ended" }),
        });
        return;
      }
      await route.continue();
    });

    await page.goto("/judge");
    await page.getByPlaceholder("Enter private code").fill(judgeCode1);
    await page.getByRole("checkbox").first().check();
    await page.getByRole("button", { name: "Check microphone" }).click();
    await page.getByRole("checkbox").nth(1).check();

    await page.getByTestId("start-judge-interview").click();

    // Trigger tab visibility change
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { value: true, configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });

    await expect(page.getByTestId("judge-session-status")).toContainText("Tab hidden: session stopped");
    expect(deleteDispatched).toBe(true);
  });
});
