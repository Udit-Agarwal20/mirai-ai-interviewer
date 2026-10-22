import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";

export type AdmissionErrorCode =
  | "invalid_invitation_code"
  | "already_consumed"
  | "global_limit_reached"
  | "store_unavailable"
  | "too_many_failed_attempts"
  | "unconfigured_admission";

export type AdmissionClaimResult =
  | { allowed: true; judgeId: string; codeHash: string }
  | { allowed: false; error: AdmissionErrorCode; message: string };

export interface RateLimitResult {
  allowed: boolean;
  error?: "too_many_failed_attempts" | "store_unavailable";
  message?: string;
}

export interface JudgeAdmissionStore {
  checkRateLimit(identifier: string): Promise<RateLimitResult>;
  recordFailedAttempt(identifier: string): Promise<RateLimitResult>;
  claimAdmission(codeHash: string, judgeLabel: string): Promise<AdmissionClaimResult>;
  resetCode?(codeHash: string): Promise<boolean>;
}

export function hashJudgeCode(code: string, salt: string = ""): string {
  const pepper = process.env.JUDGE_INVITE_SALT ?? salt;
  return createHash("sha256").update(code.trim() + pepper).digest("hex");
}

function safeStringEqual(a: string, b: string): boolean {
  if (!a || !b) return false;
  const bufA = Buffer.from(a, "hex");
  const bufB = Buffer.from(b, "hex");
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

export function validateCodeHashFormat(hash: string): boolean {
  return /^[0-9a-f]{64}$/i.test(hash);
}

export function verifyJudgeCode(rawCode: string): { valid: boolean; codeHash: string; judgeLabel: string } {
  if (!rawCode || typeof rawCode !== "string") {
    return { valid: false, codeHash: "", judgeLabel: "" };
  }
  const codeHash = hashJudgeCode(rawCode);
  const hash1 = process.env.JUDGE_INVITE_HASH_1 ?? "";
  const hash2 = process.env.JUDGE_INVITE_HASH_2 ?? "";

  if (hash1 && safeStringEqual(codeHash, hash1)) {
    return { valid: true, codeHash, judgeLabel: "judge-1" };
  }
  if (hash2 && safeStringEqual(codeHash, hash2)) {
    return { valid: true, codeHash, judgeLabel: "judge-2" };
  }

  return { valid: false, codeHash, judgeLabel: "" };
}

/**
 * Production fail-closed store used when Upstash is unconfigured or unreachable.
 * Guaranteed to NEVER permit admissions.
 */
export class FailClosedAdmissionStore implements JudgeAdmissionStore {
  constructor(private reason: string = "unconfigured_store") {}

  async checkRateLimit(): Promise<RateLimitResult> {
    return {
      allowed: false,
      error: "store_unavailable",
      message: "Durable admission store unavailable. Service is in safe default-deny mode.",
    };
  }

  async recordFailedAttempt(): Promise<RateLimitResult> {
    return {
      allowed: false,
      error: "store_unavailable",
      message: "Durable admission store unavailable. Service is in safe default-deny mode.",
    };
  }

  async claimAdmission(): Promise<AdmissionClaimResult> {
    return {
      allowed: false,
      error: "store_unavailable",
      message: "Durable admission store unavailable. Service is in safe default-deny mode.",
    };
  }

  async resetCode(): Promise<boolean> {
    return false;
  }
}

/**
 * In-memory atomic admission store used EXCLUSIVELY for offline unit/Playwright testing.
 * Strictly forbidden in hosted production mode.
 */
export class MemoryAdmissionStore implements JudgeAdmissionStore {
  private consumedCodes = new Map<string, { judgeId: string; admittedAt: number }>();
  private failedAttempts = new Map<string, number>();
  private admittedCount = 0;

  async checkRateLimit(identifier: string): Promise<RateLimitResult> {
    const current = this.failedAttempts.get(identifier) ?? 0;
    if (current >= 5) {
      return {
        allowed: false,
        error: "too_many_failed_attempts",
        message: "Too many failed attempts. Try again later.",
      };
    }
    return { allowed: true };
  }

  async recordFailedAttempt(identifier: string): Promise<RateLimitResult> {
    const current = (this.failedAttempts.get(identifier) ?? 0) + 1;
    this.failedAttempts.set(identifier, current);
    if (current >= 5) {
      return {
        allowed: false,
        error: "too_many_failed_attempts",
        message: "Too many failed attempts. Try again later.",
      };
    }
    return { allowed: true };
  }

  async claimAdmission(codeHash: string, judgeLabel: string): Promise<AdmissionClaimResult> {
    if (this.consumedCodes.has(codeHash)) {
      return {
        allowed: false,
        error: "already_consumed",
        message: "This judge invitation code has already been used for an interview.",
      };
    }
    if (this.admittedCount >= 2) {
      return {
        allowed: false,
        error: "global_limit_reached",
        message: "Maximum global judge interviews (2) reached. No further sessions permitted.",
      };
    }
    this.admittedCount++;
    this.consumedCodes.set(codeHash, { judgeId: judgeLabel, admittedAt: Date.now() });
    return { allowed: true, judgeId: judgeLabel, codeHash };
  }

  async resetCode(codeHash: string): Promise<boolean> {
    if (this.consumedCodes.delete(codeHash)) {
      this.admittedCount = Math.max(0, this.admittedCount - 1);
      return true;
    }
    return false;
  }

  get stats() {
    return { admittedCount: this.admittedCount, consumedCount: this.consumedCodes.size };
  }
}

/**
 * Production Upstash Redis REST atomic admission store.
 * Executes atomic Lua scripts over HTTPS REST adhering to documented Upstash EVAL command format:
 * POST https://<database-url> with JSON array ["EVAL", script, numkeys, keys..., args...]
 * Default-deny if Redis is unavailable, malformed, or unconfigured.
 */
export class UpstashRedisAdmissionStore implements JudgeAdmissionStore {
  constructor(
    private restUrl: string = process.env.UPSTASH_REDIS_REST_URL ?? "",
    private restToken: string = process.env.UPSTASH_REDIS_REST_TOKEN ?? "",
    private customFetch: typeof fetch = (...args) => globalThis.fetch(...args)
  ) {}

  async checkRateLimit(identifier: string): Promise<RateLimitResult> {
    if (!this.restUrl || !this.restToken) {
      return {
        allowed: false,
        error: "store_unavailable",
        message: "Durable admission store unconfigured. Default-deny enforced.",
      };
    }

    try {
      const key = `mirai:judge:failed:${createHash("sha256").update(identifier).digest("hex")}`;
      const endpoint = `${this.restUrl.replace(/\/$/, "")}/get/${key}`;
      const response = await this.customFetch(endpoint, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.restToken}`,
        },
        signal: AbortSignal.timeout(3000),
      });

      if (!response.ok) {
        return {
          allowed: false,
          error: "store_unavailable",
          message: `Durable store returned HTTP ${response.status}. Default-deny enforced.`,
        };
      }

      const data = await response.json();
      if (!data || typeof data !== "object" || data.error) {
        return {
          allowed: false,
          error: "store_unavailable",
          message: data?.error ? `Upstash error: ${data.error}` : "Malformed rate limit response.",
        };
      }

      if (data.result === null || data.result === undefined) {
        return { allowed: true };
      }

      const current = Number(data.result);
      if (isNaN(current)) {
        return {
          allowed: false,
          error: "store_unavailable",
          message: "Nonnumeric rate limit count returned from store.",
        };
      }

      if (current >= 5) {
        return {
          allowed: false,
          error: "too_many_failed_attempts",
          message: "Too many failed attempts. Try again later.",
        };
      }
      return { allowed: true };
    } catch {
      return {
        allowed: false,
        error: "store_unavailable",
        message: "Durable admission store network or timeout failure. Default-deny enforced.",
      };
    }
  }

  async recordFailedAttempt(identifier: string): Promise<RateLimitResult> {
    if (!this.restUrl || !this.restToken) {
      return {
        allowed: false,
        error: "store_unavailable",
        message: "Durable admission store unconfigured. Default-deny enforced.",
      };
    }

    try {
      const key = `mirai:judge:failed:${createHash("sha256").update(identifier).digest("hex")}`;
      const endpoint = `${this.restUrl.replace(/\/$/, "")}/pipeline`;
      const response = await this.customFetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.restToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify([
          ["INCR", key],
          ["EXPIRE", key, 600],
        ]),
        signal: AbortSignal.timeout(3000),
      });

      if (!response.ok) {
        return {
          allowed: false,
          error: "store_unavailable",
          message: `Durable store returned HTTP ${response.status}. Default-deny enforced.`,
        };
      }

      const data = await response.json();
      if (!Array.isArray(data) || !data[0] || typeof data[0] !== "object" || data[0].error) {
        return {
          allowed: false,
          error: "store_unavailable",
          message: "Malformed or error response from pipeline.",
        };
      }

      const count = Number(data[0].result);
      if (isNaN(count)) {
        return {
          allowed: false,
          error: "store_unavailable",
          message: "Nonnumeric count in pipeline response.",
        };
      }

      if (count >= 5) {
        return {
          allowed: false,
          error: "too_many_failed_attempts",
          message: "Too many failed attempts. Try again later.",
        };
      }
      return { allowed: true };
    } catch {
      return {
        allowed: false,
        error: "store_unavailable",
        message: "Durable admission store network or timeout failure. Default-deny enforced.",
      };
    }
  }

  async claimAdmission(codeHash: string, judgeLabel: string): Promise<AdmissionClaimResult> {
    if (!this.restUrl || !this.restToken) {
      return {
        allowed: false,
        error: "store_unavailable",
        message: "Durable admission store unconfigured. Default-deny enforced.",
      };
    }

    const luaScript = `
      local codeKey = KEYS[1]
      local countKey = KEYS[2]
      local maxGlobal = tonumber(ARGV[1])
      local now = ARGV[2]
      local judgeId = ARGV[3]

      local existing = redis.call('GET', codeKey)
      if existing then
        return 'ALREADY_CONSUMED'
      end

      local count = tonumber(redis.call('GET', countKey) or '0')
      if count >= maxGlobal then
        return 'GLOBAL_LIMIT_REACHED'
      end

      redis.call('SET', codeKey, cjson.encode({ judgeId = judgeId, admittedAt = now }))
      redis.call('INCR', countKey)
      return 'OK'
    `;

    try {
      // Documented Upstash REST EVAL format: POST to base endpoint with ["EVAL", script, numkeys, keys..., args...]
      const endpoint = this.restUrl.replace(/\/$/, "");
      const command = [
        "EVAL",
        luaScript,
        2,
        `mirai:judge:invite:${codeHash}`,
        `mirai:judge:admitted_count`,
        "2",
        new Date().toISOString(),
        judgeLabel,
      ];

      const response = await this.customFetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.restToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(command),
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) {
        return {
          allowed: false,
          error: "store_unavailable",
          message: `Durable store returned HTTP ${response.status}. Default-deny enforced.`,
        };
      }

      const data = await response.json();
      if (!data || typeof data !== "object" || data.error) {
        return {
          allowed: false,
          error: "store_unavailable",
          message: data?.error ? `Upstash error: ${data.error}` : "Malformed response from durable store. Default-deny enforced.",
        };
      }

      const result = data.result;
      if (result === "OK") {
        return { allowed: true, judgeId: judgeLabel, codeHash };
      }
      if (result === "ALREADY_CONSUMED") {
        return {
          allowed: false,
          error: "already_consumed",
          message: "This judge invitation code has already been used for an interview.",
        };
      }
      if (result === "GLOBAL_LIMIT_REACHED") {
        return {
          allowed: false,
          error: "global_limit_reached",
          message: "Maximum global judge interviews (2) reached. No further sessions permitted.",
        };
      }

      // Any unexpected result fails closed
      return {
        allowed: false,
        error: "store_unavailable",
        message: "Unrecognized result from durable store. Default-deny enforced.",
      };
    } catch {
      return {
        allowed: false,
        error: "store_unavailable",
        message: "Durable admission store network or timeout failure. Default-deny enforced.",
      };
    }
  }

  async resetCode(codeHash: string): Promise<boolean> {
    if (!this.restUrl || !this.restToken) return false;
    try {
      const luaScript = `
        local codeKey = KEYS[1]
        local countKey = KEYS[2]
        local deleted = redis.call('DEL', codeKey)
        if deleted > 0 then
          local current = tonumber(redis.call('GET', countKey) or '0')
          if current > 0 then
            redis.call('DECR', countKey)
          end
          return 1
        end
        return 0
      `;
      // Documented Upstash REST EVAL format: POST to base endpoint with ["EVAL", script, numkeys, keys...]
      const endpoint = this.restUrl.replace(/\/$/, "");
      const command = [
        "EVAL",
        luaScript,
        2,
        `mirai:judge:invite:${codeHash}`,
        `mirai:judge:admitted_count`,
      ];
      const response = await this.customFetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.restToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(command),
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) return false;
      const data = await response.json();
      if (!data || typeof data !== "object" || data.error) return false;
      return data.result === 1;
    } catch {
      return false;
    }
  }
}

// Global store instance for server runtime
let injectedTestingStore: JudgeAdmissionStore | null = null;

export function setAdmissionStoreForTesting(store: JudgeAdmissionStore | null) {
  if (process.env.NODE_ENV === "production" && process.env.POC_MODE === "hosted") {
    throw new Error("test_injection_forbidden_in_production");
  }
  injectedTestingStore = store;
}

/**
 * Returns the admission store.
 * In hosted production mode, MemoryAdmissionStore is FORBIDDEN and will never be returned.
 * If Upstash credentials are missing or invalid, it returns FailClosedAdmissionStore.
 */
export function getAdmissionStore(): JudgeAdmissionStore {
  const isHostedProd = process.env.NODE_ENV === "production" && process.env.POC_MODE === "hosted";
  if (injectedTestingStore && !isHostedProd) {
    return injectedTestingStore;
  }

  const isHosted = process.env.POC_MODE === "hosted";
  const upstashUrl = process.env.UPSTASH_REDIS_REST_URL;
  const upstashToken = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (isHosted) {
    // Hosted production mode: strictly require Upstash. NEVER use MemoryAdmissionStore.
    if (!upstashUrl || !upstashToken || !upstashUrl.startsWith("https://")) {
      return new FailClosedAdmissionStore("missing_or_invalid_upstash_configuration");
    }
    return new UpstashRedisAdmissionStore(upstashUrl, upstashToken);
  }

  // Non-hosted development or testing mode
  if (process.env.NODE_ENV === "test") {
    return new MemoryAdmissionStore();
  }

  if (upstashUrl && upstashToken) {
    return new UpstashRedisAdmissionStore(upstashUrl, upstashToken);
  }

  return new FailClosedAdmissionStore("unconfigured_store");
}
