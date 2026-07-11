import crypto from "node:crypto";
import { config } from "./config.js";

// ---------------------------------------------------------------------------
// APP-ISSUED WRITE TOKEN (M7.5 Part B) — anti-abuse, NOT authentication.
//
// A stateless, HMAC-signed, time-limited token. It proves only that the writer
// went through the app once (POST /api/register-device) — which makes scripted
// flooding of the surveillance data source cost more than a trivial curl loop.
// It proves NOTHING about WHO: the payload carries only issue/expiry timestamps
// and a random nonce, it is never stored server-side, and it is never linked to
// any scan row. Anonymity is a deliberate privacy choice and is preserved — see
// SAFETY.md and DECISIONS.md. This is NOT a farmer account.
// ---------------------------------------------------------------------------

const b64url = (buf) => Buffer.from(buf).toString("base64url");

function sign(payloadB64) {
  return crypto.createHmac("sha256", config.deviceTokenSecret).update(payloadB64).digest();
}

/**
 * Issue an opaque write token: `v1.<payload>.<hmac>`.
 * @returns {{token:string, expMs:number}}
 */
export function issueDeviceToken(nowMs = Date.now()) {
  const expMs = nowMs + config.deviceTokenTtlDays * 86400000;
  // No identity. `n` is a random nonce so tokens are unlinkable to each other.
  const payload = { iat: nowMs, exp: expMs, n: crypto.randomBytes(6).toString("hex") };
  const payloadB64 = b64url(JSON.stringify(payload));
  return { token: `v1.${payloadB64}.${b64url(sign(payloadB64))}`, expMs };
}

/**
 * Verify format + HMAC (constant-time) + expiry. Boolean only — never returns
 * anything derived from the payload, so nothing can grow a device→identity link.
 */
export function verifyDeviceToken(token, nowMs = Date.now()) {
  if (typeof token !== "string") return false;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return false;
  const [, payloadB64, sigB64] = parts;
  let expected, got;
  try {
    expected = sign(payloadB64);
    got = Buffer.from(sigB64, "base64url");
  } catch {
    return false;
  }
  if (expected.length !== got.length || !crypto.timingSafeEqual(expected, got)) return false;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    return false;
  }
  return Boolean(payload) && typeof payload.exp === "number" && nowMs < payload.exp;
}
