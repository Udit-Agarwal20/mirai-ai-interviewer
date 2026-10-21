import "server-only";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  AccessToken,
  AgentDispatchClient,
  RoomServiceClient,
  TrackSource,
} from "livekit-server-sdk";

export interface HostedSessionResult {
  token: string;
  url: string;
  room: string;
  identity: string;
  maxDuration: number;
  maxTurns: number;
}

export interface RequestValidationResult {
  valid: boolean;
  error?: string;
  status?: number;
}

/**
 * Strict request validation:
 * - Hosted production requires configured HTTPS APP_ORIGIN.
 * - Exact origin matching (no localhost allowed in hosted production).
 * - CSRF defense: Sec-Fetch-Site and Content-Type enforcement.
 */
export function validateHostedRequest(request: Request): RequestValidationResult {
  const isHosted = process.env.POC_MODE === "hosted";
  const appOrigin = process.env.APP_ORIGIN;

  if (isHosted) {
    if (!appOrigin || !appOrigin.startsWith("https://")) {
      return { valid: false, error: "production_origin_unconfigured", status: 500 };
    }

    const reqOrigin = request.headers.get("origin");
    if (!reqOrigin || reqOrigin !== appOrigin) {
      return { valid: false, error: "unauthorized_origin", status: 403 };
    }

    const secFetchSite = request.headers.get("sec-fetch-site");
    if (secFetchSite && !["same-origin", "same-site"].includes(secFetchSite)) {
      return { valid: false, error: "cross_origin_blocked", status: 403 };
    }

    const secFetchMode = request.headers.get("sec-fetch-mode");
    if (secFetchMode && !["cors", "same-origin"].includes(secFetchMode)) {
      return { valid: false, error: "invalid_fetch_mode", status: 403 };
    }
  } else {
    // Local development or testing mode
    const reqOrigin = request.headers.get("origin");
    const allowed = appOrigin || "http://127.0.0.1:3000";
    if (
      reqOrigin &&
      reqOrigin !== allowed &&
      reqOrigin !== "http://127.0.0.1:3000" &&
      reqOrigin !== "http://localhost:3000"
    ) {
      return { valid: false, error: "unauthorized_origin", status: 403 };
    }
  }

  // Content-Type validation on state mutations
  if (["POST", "DELETE"].includes(request.method)) {
    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("application/json")) {
      return { valid: false, error: "invalid_content_type", status: 415 };
    }
  }

  return { valid: true };
}

export function getSessionSigningSecret(): string {
  const isHosted = process.env.POC_MODE === "hosted" || process.env.NODE_ENV === "production";
  const secret = process.env.JUDGE_SESSION_SECRET;

  if (isHosted) {
    if (!secret || secret.trim().length < 32) {
      throw new Error("judge_session_secret_unconfigured");
    }
    const trimmed = secret.trim();
    const uniqueChars = new Set(trimmed).size;
    const lower = trimmed.toLowerCase();
    if (
      uniqueChars < 8 ||
      lower.includes("placeholder") ||
      lower.includes("change-me") ||
      lower.includes("secret-here")
    ) {
      throw new Error("judge_session_secret_insufficient_entropy");
    }
    return trimmed;
  }

  // Local/test fallback only: if JUDGE_SESSION_SECRET is provided, use it;
  // otherwise in non-hosted test mode only allow POC_CONTROL_SECRET if valid.
  const fallback = secret || process.env.POC_CONTROL_SECRET;
  if (!fallback || fallback.length < 32) {
    throw new Error("session_signing_secret_unconfigured");
  }
  return fallback;
}

/**
 * Creates a cryptographically signed session capability cookie.
 * Binds the exact room name, admitted judge, and expiration.
 */
export function createJudgeSessionCapability(judgeLabel: string, roomName: string): { cookieValue: string; expiresAt: number } {
  const sessionId = randomBytes(16).toString("hex");
  const expiresAt = Date.now() + 180_000; // 3 minutes TTL
  const payload = `${sessionId}.${judgeLabel}.${roomName}.${expiresAt}`;
  const signature = createHmac("sha256", getSessionSigningSecret()).update(payload).digest("hex");
  return {
    cookieValue: `${payload}.${signature}`,
    expiresAt,
  };
}

/**
 * Verifies the judge session capability cookie.
 * Strictly verifies room binding and prevents cross-judge deletion.
 */
export function verifyJudgeSessionCapability(
  token: string | undefined,
  expectedRoom?: string
): { valid: boolean; judgeLabel?: string; roomName?: string; error?: string } {
  if (!token) {
    return { valid: false, error: "missing_session_capability" };
  }

  const parts = token.split(".");
  if (parts.length !== 5) {
    return { valid: false, error: "malformed_session_capability" };
  }

  const [sessionId, judgeLabel, roomName, expiresAtStr, signature] = parts;
  if (!/^[0-9a-f]{32}$/.test(sessionId) || !/^[0-9a-f]{64}$/.test(signature)) {
    return { valid: false, error: "invalid_capability_format" };
  }

  const expiresAt = Number(expiresAtStr);
  if (isNaN(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + 300_000) {
    return { valid: false, error: "expired_session_capability" };
  }

  const payload = `${sessionId}.${judgeLabel}.${roomName}.${expiresAtStr}`;
  const expectedSig = createHmac("sha256", getSessionSigningSecret()).update(payload).digest("hex");

  const bufA = Buffer.from(signature, "hex");
  const bufB = Buffer.from(expectedSig, "hex");
  if (bufA.length !== bufB.length || !timingSafeEqual(bufA, bufB)) {
    return { valid: false, error: "invalid_signature" };
  }

  // Cross-judge room verification
  if (expectedRoom && expectedRoom !== roomName) {
    return { valid: false, error: "room_mismatch_unauthorized" };
  }

  return { valid: true, judgeLabel, roomName };
}

export interface LiveKitClients {
  roomService?: Pick<RoomServiceClient, "createRoom" | "deleteRoom">;
  dispatchClient?: Pick<AgentDispatchClient, "createDispatch">;
}

let mockClientsForTest: LiveKitClients | null = null;

export function setMockLiveKitClientsForTesting(clients: LiveKitClients | null) {
  if (process.env.NODE_ENV === "production" && process.env.POC_MODE === "hosted") {
    throw new Error("test_injection_forbidden_in_production");
  }
  mockClientsForTest = clients;
}

/**
 * Creates a LiveKit room, dispatches mirai-judge-agent, and generates a restricted token.
 * CLEANUP ON PARTIAL FAILURE: If dispatch or token generation fails, the room is deleted immediately.
 */
export async function createHostedSession(judgeLabel: string): Promise<HostedSessionResult> {
  const isHosted = process.env.POC_MODE === "hosted" || process.env.NODE_ENV === "production";
  const apiKey = process.env.LIVEKIT_API_KEY?.trim();
  const apiSecret = process.env.LIVEKIT_API_SECRET?.trim();
  const rawUrl = process.env.LIVEKIT_URL?.trim();

  if (isHosted) {
    if (!apiKey || !apiSecret) {
      throw new Error("livekit_credentials_unconfigured");
    }
    if (!rawUrl || !rawUrl.startsWith("wss://") || rawUrl.includes("mock.livekit.cloud") || rawUrl.includes("example.com")) {
      throw new Error("livekit_url_invalid_or_unconfigured");
    }
  } else {
    if (!apiKey || !apiSecret) {
      throw new Error("livekit_credentials_unconfigured");
    }
  }

  const livekitUrl = rawUrl || (mockClientsForTest ? "wss://mock.livekit.cloud" : "");
  if (!livekitUrl) {
    throw new Error("livekit_url_unconfigured");
  }

  const roomSuffix = randomBytes(6).toString("hex");
  const roomName = `mirai-judge-${roomSuffix}`;
  const identity = `judge-${judgeLabel}-${randomBytes(4).toString("hex")}`;

  const roomService = mockClientsForTest?.roomService ?? new RoomServiceClient(livekitUrl, apiKey, apiSecret);
  const dispatchClient = mockClientsForTest?.dispatchClient ?? new AgentDispatchClient(livekitUrl, apiKey, apiSecret);

  let roomCreated = false;
  try {
    // 1. Create room
    await roomService.createRoom({
      name: roomName,
      emptyTimeout: 30,
      departureTimeout: 10,
      maxParticipants: 2,
    });
    roomCreated = true;

    // 2. Explicit agent dispatch to mirai-judge-agent
    await dispatchClient.createDispatch(roomName, "mirai-judge-agent", {
      metadata: JSON.stringify({ judgeLabel, maxDuration: 60, maxTurns: 3 }),
    });

    // 3. Short-lived (60s), room-scoped, microphone-only participant token
    const token = new AccessToken(apiKey, apiSecret, {
      identity,
      ttl: "60s",
      name: `Judge (${judgeLabel})`,
    });

    token.addGrant({
      roomJoin: true,
      room: roomName,
      canPublish: true,
      canSubscribe: true,
      canPublishData: false,
      canPublishSources: [TrackSource.MICROPHONE],
      canUpdateOwnMetadata: false,
    });

    const jwt = await token.toJwt();

    return {
      token: jwt,
      url: livekitUrl,
      room: roomName,
      identity,
      maxDuration: 60,
      maxTurns: 3,
    };
  } catch (error) {
    // Clean up newly created room on any subsequent failure (dispatch failure, token error, etc.)
    if (roomCreated) {
      try {
        await roomService.deleteRoom(roomName);
      } catch {}
    }
    throw error;
  }
}

export async function stopHostedSession(roomName: string): Promise<boolean> {
  const isHosted = process.env.POC_MODE === "hosted" || process.env.NODE_ENV === "production";
  const apiKey = process.env.LIVEKIT_API_KEY?.trim();
  const apiSecret = process.env.LIVEKIT_API_SECRET?.trim();
  const rawUrl = process.env.LIVEKIT_URL?.trim();

  if (!apiKey || !apiSecret || !roomName) return false;
  if (isHosted && (!rawUrl || !rawUrl.startsWith("wss://") || rawUrl.includes("mock.livekit.cloud"))) {
    return false;
  }

  const livekitUrl = rawUrl || (mockClientsForTest ? "wss://mock.livekit.cloud" : "");
  if (!livekitUrl) return false;

  try {
    const roomService = mockClientsForTest?.roomService ?? new RoomServiceClient(livekitUrl, apiKey, apiSecret);
    await roomService.deleteRoom(roomName);
    return true;
  } catch {
    return false;
  }
}
