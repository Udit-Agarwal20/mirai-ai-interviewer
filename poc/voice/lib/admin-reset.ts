import "server-only";
import { getAdmissionStore, hashJudgeCode } from "./hosted-admission";

/**
 * Manual administrative reset procedure for a judge invitation code.
 * Requires explicit ADMIN_RESET_SECRET.
 * No automatic retries or refunds.
 */
export async function adminResetJudgeInvitation(
  secret: string,
  rawCodeOrHash: string
): Promise<{ success: boolean; message: string }> {
  const adminSecret = process.env.ADMIN_RESET_SECRET ?? "";
  if (!adminSecret || adminSecret.length < 32 || secret !== adminSecret) {
    return { success: false, message: "Unauthorized: valid ADMIN_RESET_SECRET required." };
  }

  const codeHash = rawCodeOrHash.length === 64 ? rawCodeOrHash : hashJudgeCode(rawCodeOrHash);
  const store = getAdmissionStore();

  if (!store.resetCode) {
    return { success: false, message: "Admission store does not support reset." };
  }

  const reset = await store.resetCode(codeHash);
  if (reset) {
    return { success: true, message: `Successfully reset admission record for hash ${codeHash.slice(0, 12)}…` };
  }
  return { success: false, message: "Record not found or not in consumed state." };
}
