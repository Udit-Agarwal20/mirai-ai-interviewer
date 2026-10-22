import { safeJson } from "../../../../../lib/access";
import { getAdmissionStore, verifyJudgeCode } from "../../../../../lib/hosted-admission";
import {
  createHostedSession,
  createJudgeSessionCapability,
  HostedSessionError,
  stopHostedSession,
  validateHostedEnvironment,
  validateHostedRequest,
  verifyJudgeSessionCapability,
} from "../../../../../lib/hosted-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function getClientIdentifier(request: Request): string {
  const xff = request.headers.get("x-forwarded-for");
  if (xff) {
    const parts = xff.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length > 0) {
      // In trusted reverse-proxy topologies (Render), proxy appends verified client IP to the end.
      const rightmost = parts[parts.length - 1];
      if (/^[0-9a-fA-F:.]+$/.test(rightmost)) {
        return rightmost;
      }
    }
  }
  return "unknown_client";
}

export async function POST(request: Request) {
  const validation = validateHostedRequest(request);
  if (!validation.valid) {
    return safeJson({ error: validation.error ?? "unauthorized", message: "Request validation failed." }, validation.status ?? 403);
  }

  let body: { inviteCode?: string; consent?: boolean; preflight?: boolean };
  try {
    const raw = await request.text();
    if (raw.length > 2048) {
      return safeJson({ error: "payload_too_large", message: "Payload exceeds 2048 bytes." }, 400);
    }
    body = JSON.parse(raw);
  } catch {
    return safeJson({ error: "invalid_payload", message: "Malformed JSON payload." }, 400);
  }

  if (body.consent !== true || body.preflight !== true) {
    return safeJson({
      error: "consent_and_preflight_required",
      message: "Microphone preflight and live consent are required before admission."
    }, 400);
  }

  const inviteCode = body.inviteCode;
  if (!inviteCode || typeof inviteCode !== "string") {
    return safeJson({ error: "invalid_invitation_code", message: "Judge invitation code required." }, 403);
  }

  const store = getAdmissionStore();
  const clientIdentifier = getClientIdentifier(request);

  // 1. Enforce rate limiting BEFORE expensive admission work or code verification
  const rateLimit = await store.checkRateLimit(clientIdentifier);
  if (!rateLimit.allowed) {
    const status = rateLimit.error === "too_many_failed_attempts" ? 429 : 503;
    return safeJson({
      error: rateLimit.error ?? "too_many_failed_attempts",
      message: rateLimit.message ?? "Too many failed attempts. Try again later."
    }, status);
  }

  // 2. Verify invitation code against provisioned salted hashes
  const verification = verifyJudgeCode(inviteCode);
  if (!verification.valid) {
    const recordResult = await store.recordFailedAttempt(clientIdentifier);
    if (recordResult.error === "store_unavailable") {
      return safeJson({
        error: "store_unavailable",
        message: "Durable admission store unavailable. Service is in safe default-deny mode."
      }, 503);
    }
    return safeJson({
      error: "invalid_invitation_code",
      message: "Invalid judge invitation code."
    }, 403);
  }

  // 3. Pre-validate server environment and voice credentials BEFORE claiming the invitation code.
  // An unconfigured server environment must NEVER burn a judge single-use invitation.
  const envValidation = validateHostedEnvironment();
  if (!envValidation.valid) {
    return safeJson({
      error: envValidation.error ?? "server_configuration_error",
      message: "Server voice infrastructure is unconfigured or invalid. Invitation code preserved."
    }, envValidation.status ?? 503);
  }

  // 4. Atomic durable admission claim (max 1 per code, max 2 globally; fail-closed on outage)
  const claim = await store.claimAdmission(verification.codeHash, verification.judgeLabel);
  if (!claim.allowed) {
    const status = claim.error === "store_unavailable" ? 503 : 409;
    return safeJson({ error: claim.error, message: claim.message }, status);
  }

  // 5. Create room, dispatch agent worker, and generate short-lived token
  let session;
  try {
    session = await createHostedSession(claim.judgeId);
  } catch (dispatchError: any) {
    // Fail-closed rule: Disable automatic invitation rollback after ANY attempted remote room creation.
    // Network timeouts, lost responses, or remote rejections leave remote status uncertain.
    // Keep already-consumed invitations claimed until an administrator verifies the room
    // and agent have stopped and explicitly authorizes recovery via ADMIN_RESET_SECRET.
    await store.recordFailedAttempt(clientIdentifier);

    return safeJson({
      error: "session_dispatch_uncertain",
      message: "Interview session startup could not be completed and room status is uncertain. To protect assessment integrity, please contact the hackathon administrator."
    }, 502);
  }

  // 6. Generate cryptographically signed session capability cookie
  let capability;
  try {
    capability = createJudgeSessionCapability(claim.judgeId, session.room);
  } catch (capError: any) {
    // Session capability signing failed after agent dispatch. Initiate room cleanup.
    // Fail-closed rule: NEVER automatically restore code since an agent was already dispatched.
    await stopHostedSession(session.room);
    await store.recordFailedAttempt(clientIdentifier);

    return safeJson({
      error: "session_signing_unavailable",
      message: "Session signing failed after agent dispatch. Room cleanup initiated. To protect assessment integrity, please contact the administrator."
    }, 503);
  }

  const isHttps = process.env.APP_ORIGIN?.startsWith("https://") || process.env.NODE_ENV === "production";
  const secureFlag = isHttps ? "Secure; " : "";
  const cookieHeader = `mirai_judge_session=${capability.cookieValue}; HttpOnly; SameSite=Strict; ${secureFlag}Path=/api/poc/judge/session; Max-Age=180`;

  const response = safeJson(session, 200);
  response.headers.set("Set-Cookie", cookieHeader);
  return response;
}

export async function DELETE(request: Request) {
  const validation = validateHostedRequest(request);
  if (!validation.valid) {
    return safeJson({ error: validation.error ?? "unauthorized" }, validation.status ?? 403);
  }

  // 1. Extract session capability cookie
  const cookieHeader = request.headers.get("cookie") ?? "";
  const sessionCookie = cookieHeader
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith("mirai_judge_session="))
    ?.slice("mirai_judge_session=".length);

  // 2. Parse request body if room was passed
  let requestRoom: string | undefined;
  try {
    const raw = await request.text();
    if (raw) {
      const data = JSON.parse(raw);
      if (typeof data.room === "string") {
        requestRoom = data.room;
      }
    }
  } catch {}

  // 3. Cryptographically verify session capability and room ownership
  try {
    const verified = verifyJudgeSessionCapability(sessionCookie, requestRoom);
    if (!verified.valid || !verified.roomName) {
      return safeJson({
        error: "unauthorized_deletion",
        message: "Deletion unauthorized: missing, expired, or mismatched session capability."
      }, 403);
    }

    // 4. Delete the authorized room
    const stopped = await stopHostedSession(verified.roomName);
    if (!stopped) {
      // Must not report successful termination when room deletion failed!
      return safeJson({
        error: "room_deletion_failed",
        message: "Room deletion could not be verified with voice provider. Server 60-second timer will enforce termination."
      }, 502);
    }

    // 5. Clear capability cookie
    const response = safeJson({ state: "ended" }, 200);
    response.headers.set("Set-Cookie", "mirai_judge_session=; Path=/api/poc/judge/session; Max-Age=0; HttpOnly; SameSite=Strict");
    return response;
  } catch {
    return safeJson({
      error: "unauthorized_deletion",
      message: "Deletion unauthorized: capability verification failed."
    }, 403);
  }
}
