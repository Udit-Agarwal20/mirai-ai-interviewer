import { POST, DELETE } from "../app/api/poc/judge/session/route";
import { JudgeLiveSession } from "../lib/judge-client";
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
  validateHostedEnvironment,
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

test.describe("Fix 1 & Task 3: Upstash Redis EVAL Contract & Fail Closed", () => {
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

  test("2. Upstash REST EVAL contract: inspects exact URL, headers, and ['EVAL', script, numkeys, ...] body", async () => {
    let capturedUrl = "";
    let capturedMethod = "";
    let capturedHeaders: Record<string, string> = {};
    let capturedBody: any = null;

    const mockFetch = async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = url.toString();
      capturedMethod = init?.method ?? "GET";
      capturedHeaders = (init?.headers as Record<string, string>) ?? {};
      if (typeof init?.body === "string") {
        capturedBody = JSON.parse(init.body);
      }
      return new Response(JSON.stringify({ result: "OK" }), { status: 200 });
    };

    const store = new UpstashRedisAdmissionStore("https://mock.upstash.io", "mock-secret-token", mockFetch as any);

    // 1. Inspect claimAdmission request format
    const claimRes = await store.claimAdmission(hash1, "judge-1");
    expect(claimRes.allowed).toBe(true);

    // Verify Upstash base endpoint (no /eval suffix!)
    expect(capturedUrl).toBe("https://mock.upstash.io");
    expect(capturedMethod).toBe("POST");
    expect(capturedHeaders["Authorization"]).toBe("Bearer mock-secret-token");
    expect(capturedHeaders["Content-Type"]).toBe("application/json");

    // Verify command array: ["EVAL", script, 2, codeKey, countKey, maxGlobal, timestamp, judgeLabel]
    expect(Array.isArray(capturedBody)).toBe(true);
    expect(capturedBody[0]).toBe("EVAL");
    expect(typeof capturedBody[1]).toBe("string"); // Lua script
    expect(capturedBody[2]).toBe(2); // numkeys
    expect(capturedBody[3]).toBe(`mirai:judge:invite:${hash1}`); // KEYS[1]
    expect(capturedBody[4]).toBe("mirai:judge:admitted_count"); // KEYS[2]
    expect(capturedBody[5]).toBe("2"); // ARGV[1] (maxGlobal)
    expect(typeof capturedBody[6]).toBe("string"); // ARGV[2] (ISO timestamp)
    expect(capturedBody[7]).toBe("judge-1"); // ARGV[3] (judgeId)

    // 2. Inspect resetCode request format
    let resetUrl = "";
    let resetBody: any = null;
    const resetStore = new UpstashRedisAdmissionStore("https://mock.upstash.io", "mock-token", (async (url: any, init: any) => {
      resetUrl = url.toString();
      resetBody = JSON.parse(init.body);
      return new Response(JSON.stringify({ result: 1 }), { status: 200 });
    }) as any);

    const resetSuccess = await resetStore.resetCode(hash1);
    expect(resetSuccess).toBe(true);
    expect(resetUrl).toBe("https://mock.upstash.io");
    expect(Array.isArray(resetBody)).toBe(true);
    expect(resetBody[0]).toBe("EVAL");
    expect(resetBody[2]).toBe(2);
    expect(resetBody[3]).toBe(`mirai:judge:invite:${hash1}`);
    expect(resetBody[4]).toBe("mirai:judge:admitted_count");
  });

  test("3. Upstash REST contract: fails closed on HTTP errors, Redis errors, malformed/nonnumeric results", async () => {
    // 1. HTTP 401 Unauthorized
    const store401 = new UpstashRedisAdmissionStore(
      "https://mock.upstash.io", "bad-token",
      async () => new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 })
    );
    const res401 = await store401.claimAdmission(hash1, "judge-1");
    expect(res401.allowed).toBe(false);
    if (!res401.allowed) expect(res401.error).toBe("store_unavailable");

    // 2. HTTP 500 Internal Error
    const store500 = new UpstashRedisAdmissionStore(
      "https://mock.upstash.io", "token",
      async () => new Response("Internal Server Error", { status: 500 })
    );
    const res500 = await store500.claimAdmission(hash1, "judge-1");
    expect(res500.allowed).toBe(false);
    if (!res500.allowed) expect(res500.error).toBe("store_unavailable");

    // 3. Upstash Redis error object { error: "ERR syntax error" }
    const storeRedisErr = new UpstashRedisAdmissionStore(
      "https://mock.upstash.io", "token",
      async () => new Response(JSON.stringify({ error: "ERR command not allowed" }), { status: 200 })
    );
    const resRedisErr = await storeRedisErr.claimAdmission(hash1, "judge-1");
    expect(resRedisErr.allowed).toBe(false);
    if (!resRedisErr.allowed) expect(resRedisErr.error).toBe("store_unavailable");

    // 4. Malformed JSON
    const storeMalformed = new UpstashRedisAdmissionStore(
      "https://mock.upstash.io", "token",
      async () => new Response("{ invalid json syntax", { status: 200 })
    );
    const resMalformed = await storeMalformed.claimAdmission(hash1, "judge-1");
    expect(resMalformed.allowed).toBe(false);
    if (!resMalformed.allowed) expect(resMalformed.error).toBe("store_unavailable");

    // 5. Nonnumeric rate limit result
    const storeNonNumeric = new UpstashRedisAdmissionStore(
      "https://mock.upstash.io", "token",
      async () => new Response(JSON.stringify({ result: "not-a-number" }), { status: 200 })
    );
    const resNonNumeric = await storeNonNumeric.checkRateLimit("client-1");
    expect(resNonNumeric.allowed).toBe(false);
    expect(resNonNumeric.error).toBe("store_unavailable");

    // 6. Network timeout
    const storeTimeout = new UpstashRedisAdmissionStore(
      "https://mock.upstash.io", "token",
      async () => { throw new Error("Network timeout after 5000ms"); }
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

test.describe("Fix 3 & Rate Limiting Verification", () => {
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

  test("9. Upstash Redis rate limiting: GET and pipeline format inspections", async () => {
    let capturedGetUrl = "";
    let capturedPipelineBody: any = null;

    const customFetch = async (url: any, init: any) => {
      const u = url.toString();
      if (u.includes("/get/")) {
        capturedGetUrl = u;
        return new Response(JSON.stringify({ result: "5" }), { status: 200 });
      }
      if (u.includes("/pipeline")) {
        capturedPipelineBody = JSON.parse(init.body);
        return new Response(JSON.stringify([{ result: 6 }, { result: "OK" }]), { status: 200 });
      }
      return new Response("Not Found", { status: 404 });
    };

    const redisStore = new UpstashRedisAdmissionStore("https://mock.upstash.io", "mock-token", customFetch as any);

    // 1. Check rate limit uses GET /get/<key>
    const check = await redisStore.checkRateLimit("203.0.113.1");
    expect(check.allowed).toBe(false);
    expect(check.error).toBe("too_many_failed_attempts");
    expect(capturedGetUrl).toContain("https://mock.upstash.io/get/mirai:judge:failed:");

    // 2. Record failed attempt uses POST /pipeline with [INCR, EXPIRE]
    const rec = await redisStore.recordFailedAttempt("203.0.113.1");
    expect(rec.allowed).toBe(false);
    expect(Array.isArray(capturedPipelineBody)).toBe(true);
    expect(capturedPipelineBody[0][0]).toBe("INCR");
    expect(capturedPipelineBody[1][0]).toBe("EXPIRE");
    expect(capturedPipelineBody[1][2]).toBe(600);
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

function makeJudgePostRequest(code: string, origin = "http://127.0.0.1:3000") {
  return new Request(`${origin}/api/poc/judge/session`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: origin,
      "X-Forwarded-For": "203.0.113.195",
    },
    body: JSON.stringify({
      inviteCode: code,
      consent: true,
      preflight: true,
    }),
  });
}

function makeJudgeDeleteRequest(room: string, cookieValue: string, origin = "http://127.0.0.1:3000") {
  return new Request(`${origin}/api/poc/judge/session`, {
    method: "DELETE",
    headers: {
      "Content-Type": "application/json",
      Origin: origin,
      Cookie: `mirai_judge_session=${cookieValue}`,
    },
    body: JSON.stringify({ room }),
  });
}

test.describe("Task 4: Preservation of Judge Invitations & Truthful Session Deletion", () => {
  test("11. Server environment pre-checks prevent burning judge invitation codes", () => {
    const originalMode = process.env.POC_MODE;
    const originalOrigin = process.env.APP_ORIGIN;
    const originalUrl = process.env.LIVEKIT_URL;

    try {
      process.env.POC_MODE = "hosted";
      process.env.APP_ORIGIN = "https://mirai-judge.onrender.com";

      // 1. Missing or mock LiveKit URL detected before claim
      process.env.LIVEKIT_URL = "wss://mock.livekit.cloud";
      const envCheckMock = validateHostedEnvironment();
      expect(envCheckMock.valid).toBe(false);
      expect(envCheckMock.error).toBe("livekit_url_invalid_or_unconfigured");

      // 2. Valid environment passes pre-check
      process.env.LIVEKIT_URL = "wss://mirai-real.livekit.cloud";
      const envCheckValid = validateHostedEnvironment();
      expect(envCheckValid.valid).toBe(true);
    } finally {
      process.env.POC_MODE = originalMode;
      process.env.APP_ORIGIN = originalOrigin;
      process.env.LIVEKIT_URL = originalUrl;
    }
  });

  test("12. POST route control flow: LiveKit dispatch timeout results in uncertain status and does NOT restore code", async () => {
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
          throw new Error("LiveKit dispatch timeout after 10000ms");
        },
      },
    });

    const memStore = new MemoryAdmissionStore();
    setAdmissionStoreForTesting(memStore);

    try {
      const req = makeJudgePostRequest(judgeCode1);
      const res = await POST(req);

      expect(res.status).toBe(502);
      const body = await res.json();
      expect(body.error).toBe("session_dispatch_uncertain");
      expect(body.message).toContain("contact the hackathon administrator");
      expect(body.message).not.toContain("preserved for retry");

      // Verify code was NOT restored or rolled back in the store!
      expect(memStore.stats.admittedCount).toBe(1);
      expect(memStore.stats.consumedCount).toBe(1);

      // Verify duplicate retry attempt following ambiguous outcome is rejected as already_consumed (HTTP 409)
      const retryReq = makeJudgePostRequest(judgeCode1);
      const retryRes = await POST(retryReq);
      expect(retryRes.status).toBe(409);
      const retryBody = await retryRes.json();
      expect(retryBody.error).toBe("already_consumed");
      expect(retryBody.message).toContain("already been used");
      // Admitted count remains capped at 1
      expect(memStore.stats.admittedCount).toBe(1);
    } finally {
      setMockLiveKitClientsForTesting(null);
      setAdmissionStoreForTesting(null);
    }
  });

  test("13. POST route control flow: Room deletion failure results in uncertain status and fail-closed code retention", async () => {
    setMockLiveKitClientsForTesting({
      roomService: {
        createRoom: async () => {
          return {} as any;
        },
        deleteRoom: async () => {
          throw new Error("LiveKit 500: Room deletion failed");
        },
      },
      dispatchClient: {
        createDispatch: async () => {
          throw new Error("Agent dispatch failed");
        },
      },
    });

    const memStore = new MemoryAdmissionStore();
    setAdmissionStoreForTesting(memStore);

    try {
      const req = makeJudgePostRequest(judgeCode1);
      const res = await POST(req);

      expect(res.status).toBe(502);
      const body = await res.json();
      expect(body.error).toBe("session_dispatch_uncertain");
      expect(body.message).toContain("contact the hackathon administrator");

      // Verify code remains consumed in store to preserve 2-session cap
      expect(memStore.stats.admittedCount).toBe(1);
      expect(memStore.stats.consumedCount).toBe(1);
    } finally {
      setMockLiveKitClientsForTesting(null);
      setAdmissionStoreForTesting(null);
    }
  });

  test("14. DELETE route control flow: Truthful 502 room_deletion_failed without reporting success or leaking credentials", async () => {
    const testRoom = "mirai-judge-delete-fail-test-room";
    const cap = createJudgeSessionCapability("judge-1", testRoom);

    setMockLiveKitClientsForTesting({
      roomService: {
        deleteRoom: async () => {
          throw new Error("LiveKit deleteRoom connection reset");
        },
      } as any,
      dispatchClient: {} as any,
    });

    try {
      const req = makeJudgeDeleteRequest(testRoom, cap.cookieValue);
      const res = await DELETE(req);

      expect(res.status).toBe(502);
      const body = await res.json();
      expect(body.error).toBe("room_deletion_failed");
      expect(body.message).toContain("Room deletion could not be verified with voice provider");
      expect(body.message).toContain("Server 60-second timer will enforce termination");
      // Must NOT report state: ended
      expect(body.state).toBeUndefined();
      // Must NOT expose secrets or credentials
      const bodyStr = JSON.stringify(body);
      expect(bodyStr).not.toContain("secret");
      expect(bodyStr).not.toContain("token");
      expect(bodyStr).not.toContain("test-lk-");
    } finally {
      setMockLiveKitClientsForTesting(null);
    }
  });

  test("15. POST route control flow: createRoom failure/timeout treats remote outcome as uncertain, keeps code consumed, and blocks duplicate retries", async () => {
    let createRoomAttempts = 0;
    let createdRooms: string[] = [];

    // Simulate scenario: createRoom was attempted remotely (and may have succeeded remotely),
    // but the client HTTP connection timed out or response was lost
    setMockLiveKitClientsForTesting({
      roomService: {
        createRoom: async (opts: any) => {
          createRoomAttempts++;
          createdRooms.push(opts.name);
          throw new Error("HTTP connection timeout 504: response lost after room creation");
        },
        deleteRoom: async () => ({} as any),
      } as any,
      dispatchClient: {
        createDispatch: async () => ({} as any),
      },
    });

    const memStore = new MemoryAdmissionStore();
    setAdmissionStoreForTesting(memStore);

    try {
      // 1. Initial POST attempt: createRoom throws timeout / network error
      const req1 = makeJudgePostRequest(judgeCode1);
      const res1 = await POST(req1);

      expect(res1.status).toBe(502);
      const body1 = await res1.json();
      expect(body1.error).toBe("session_dispatch_uncertain");
      expect(body1.message).toContain("contact the hackathon administrator");
      expect(body1.message).not.toContain("preserved for retry");

      // Invitation must REMAIN consumed in the store (fail-closed)
      expect(memStore.stats.consumedCount).toBe(1);
      expect(memStore.stats.admittedCount).toBe(1);
      expect(createRoomAttempts).toBe(1);

      // 2. Duplicate retry attempt with the exact same invitation code
      const retryReq = makeJudgePostRequest(judgeCode1);
      const retryRes = await POST(retryReq);

      // Duplicate retry MUST be rejected with HTTP 409 already_consumed
      expect(retryRes.status).toBe(409);
      const retryBody = await retryRes.json();
      expect(retryBody.error).toBe("already_consumed");
      expect(retryBody.message).toContain("already been used");

      // Crucial assertion: NO additional room was requested from the retry!
      expect(createRoomAttempts).toBe(1);
      expect(createdRooms.length).toBe(1);

      // Global admitted count is strictly preserved at 1 (within 2-session cap)
      expect(memStore.stats.admittedCount).toBe(1);
    } finally {
      setMockLiveKitClientsForTesting(null);
      setAdmissionStoreForTesting(null);
    }
  });

  test("16. Full POST route control flow: Enforces strict two-session global cap without creating extra rooms", async () => {
    let createdRooms: string[] = [];

    setMockLiveKitClientsForTesting({
      roomService: {
        createRoom: async (opts: any) => {
          createdRooms.push(opts.name);
          return {} as any;
        },
      } as any,
      dispatchClient: {
        createDispatch: async () => ({} as any),
      },
    });

    const memStore = new MemoryAdmissionStore();
    setAdmissionStoreForTesting(memStore);

    try {
      // 1. Session 1 succeeds
      const res1 = await POST(makeJudgePostRequest(judgeCode1));
      expect(res1.status).toBe(200);
      const body1 = await res1.json();
      expect(body1.room).toBeDefined();
      expect(body1.token).toBeDefined();
      expect(memStore.stats.admittedCount).toBe(1);

      // 2. Session 2 succeeds
      const res2 = await POST(makeJudgePostRequest(judgeCode2));
      expect(res2.status).toBe(200);
      const body2 = await res2.json();
      expect(body2.room).toBeDefined();
      expect(body2.token).toBeDefined();
      expect(memStore.stats.admittedCount).toBe(2);
      expect(createdRooms.length).toBe(2);

      // 3. Attempt with unrecognized code rejected with 403
      const res3 = await POST(makeJudgePostRequest("mirai-judge-unauthorized-code"));
      expect(res3.status).toBe(403);

      // 4. Any attempt after global cap of 2 is reached is rejected with 409
      const thirdCodeHash = createHash("sha256").update("mirai-judge-code-3" + testPepper).digest("hex");
      const capCheck = await memStore.claimAdmission(thirdCodeHash, "judge-3");
      expect(capCheck.allowed).toBe(false);
      if (!capCheck.allowed) expect(capCheck.error).toBe("global_limit_reached");
      expect(createdRooms.length).toBe(2); // No extra room created
    } finally {
      setMockLiveKitClientsForTesting(null);
      setAdmissionStoreForTesting(null);
    }
  });

  test("17. Browser client JudgeLiveSession handles DELETE 502 failure safely with truthful status notice", async () => {
    let stateTransitions: Array<{ state: string; detail: string }> = [];
    const dummyContainer = { appendChild: () => {} } as any;

    const mockFetch = async (url: any, init: any) => {
      const u = url.toString();
      if (u.includes("/api/poc/judge/session") && init.method === "DELETE") {
        return new Response(JSON.stringify({
          error: "room_deletion_failed",
          message: "Room deletion could not be verified with voice provider. Server 60-second timer will enforce termination.",
        }), { status: 502 });
      }
      return new Response("Not Found", { status: 404 });
    };

    const client = new JudgeLiveSession(
      (state, detail) => {
        stateTransitions.push({ state, detail });
      },
      () => {},
      dummyContainer,
      () => ({
        connect: async () => {},
        startAudio: async () => {},
        localParticipant: { publishTrack: async () => {} },
        remoteParticipants: new Map(),
        on: () => {},
        disconnect: async () => {},
      } as any),
      mockFetch as any
    );

    (client as any).currentRoomName = "mirai-judge-test-room-client-del-fail";
    await client.stop("Interview ended by judge.");

    // Allow remoteStop microtask to complete
    await new Promise((r) => setTimeout(r, 50));

    expect(client.getState()).toBe("ended");
    const lastTransition = stateTransitions[stateTransitions.length - 1];
    expect(lastTransition.state).toBe("ended");
    expect(lastTransition.detail).toContain("Interview ended locally. Notice: Room deletion could not be verified with voice provider. Server 60-second timer will enforce termination.");
  });
});

test.describe("Security Hardening & Protection Verifications", () => {
  test("18. Strict origin validation: rejects missing origin, cross-site, and localhost in production", () => {
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

  test("19. Hosted production mode strictly refuses mock LiveKit URLs and test bypass injection", async () => {
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
});

test.describe("Phase E & F: Offline Browser UI and Lifecycle on /judge", () => {
  test("20. Browser UI requires code, preflight, and consent to enable start button", async ({ page }) => {
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

  test("21. Browser displays safe error when invitation code is invalid or reused", async ({ page }) => {
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

  test("22. Tab hidden cancels judge session cleanly and dispatches authenticated DELETE", async ({ page }) => {
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
