#!/usr/bin/env node
/**
 * MIRAI AI INTERVIEWER — JUDGE INVITATION SECURITY GENERATOR
 *
 * CRITICAL OPERATOR INSTRUCTIONS:
 * 1. RUN THIS SCRIPT LOCALLY ONCE IN A SECURE TERMINAL:
 *    node scripts/generate-invitations.js
 *
 * 2. SECURELY STORE THE TWO INVITATION CODES:
 *    - Save both plaintext codes into a private secrets vault (e.g., 1Password, Bitwarden, KeePass).
 *    - NEVER commit, write to disk, log, or push plaintext codes to Git, issue trackers, or PRs.
 *
 * 3. PRIVATELY DELIVER TO EACH JUDGE INDIVIDUALLY:
 *    - Deliver Code 1 to Judge 1 and Code 2 to Judge 2 via an end-to-end encrypted channel
 *      (e.g., Signal, private 1Password item share link, or direct encrypted DM).
 *    - Remind the judges: each code is strictly single-use and valid for exactly one 60-second interview.
 *
 * 4. CONFIGURE RENDER ENVIRONMENT VARIABLES:
 *    - Copy ONLY the section marked "RENDER DASHBOARD ENVIRONMENT VARIABLES" into Render Dashboard Settings.
 *    - Neither Render nor LiveKit nor the database will ever see or store the plaintext codes.
 */
const crypto = require("node:crypto");

function generate() {
  const salt = crypto.randomBytes(32).toString("hex");
  const adminSecret = crypto.randomBytes(32).toString("hex");
  const sessionSecret = crypto.randomBytes(32).toString("hex");

  // High-entropy 128-bit private invitation codes
  const code1 = `mirai-judge-alpha-${crypto.randomBytes(16).toString("hex")}`;
  const code2 = `mirai-judge-beta-${crypto.randomBytes(16).toString("hex")}`;

  const hash1 = crypto.createHash("sha256").update(code1 + salt).digest("hex");
  const hash2 = crypto.createHash("sha256").update(code2 + salt).digest("hex");

  console.log("================================================================================");
  console.log("MIRAI AI INTERVIEWER — JUDGE INVITATION & SECRET GENERATOR");
  console.log("================================================================================\n");

  console.log("--- 1. RENDER DASHBOARD ENVIRONMENT VARIABLES (PASTE INTO RENDER SETTINGS) ---");
  console.log(`JUDGE_INVITE_SALT=${salt}`);
  console.log(`JUDGE_INVITE_HASH_1=${hash1}`);
  console.log(`JUDGE_INVITE_HASH_2=${hash2}`);
  console.log(`ADMIN_RESET_SECRET=${adminSecret}`);
  console.log(`JUDGE_SESSION_SECRET=${sessionSecret}\n`);

  console.log("--- 2. PRIVATE JUDGE INVITATION CODES (DELIVER PRIVATELY TO EACH JUDGE) ---");
  console.log(`JUDGE 1 INVITATION CODE: ${code1}`);
  console.log(`JUDGE 2 INVITATION CODE: ${code2}\n`);

  console.log("--- 3. OPERATOR PROTOCOL ---");
  console.log("✓ Store these two codes in a password vault immediately.");
  console.log("✓ Share each code directly with its assigned judge via secure, end-to-end DM.");
  console.log("✓ NEVER write plaintext codes into git, documentation, tickets, or repo files.");
  console.log("✓ The application server only validates SHA-256 salted hashes.");
  console.log("================================================================================");
}

generate();
