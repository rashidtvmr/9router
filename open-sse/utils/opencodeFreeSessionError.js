import { OPENCODE_FREE_ERROR_STATUSES, OPENCODE_FREE_ERROR_TEXTS } from "../config/opencodeFreeSession.js";
import { opencodeNativeSessionCache } from "./opencodeNativeSessionCache.js";

export function isFreeTierEligibilityError(error, statusCode) {
  const status = statusCode ?? error?.status ?? error?.response?.status;
  if (status === 429 || status === 402) return true;
  const text = typeof error === "string" ? error : error?.message || error?.body || error?.responseText || "";
  const lower = String(text).toLowerCase();
  if (lower.includes("freetiererror")) return true;
  return status === 403 && OPENCODE_FREE_ERROR_TEXTS.some((needle) => lower.includes(needle.toLowerCase()));
}

export async function isOpenCodeFreeError(response, bodyText = null) {
  if (!response) return false;
  if (response.status === 429 || response.status === 402) return true;
  if (bodyText == null) {
    try { bodyText = typeof response.clone === "function" ? await response.clone().text() : await response.text?.(); } catch { bodyText = ""; }
  }
  return isFreeTierEligibilityError(bodyText, response.status);
}

/**
 * Stricter variant for the KEYED opencode-zen lane: no status short-circuit, so
 * every status (including 429/402) must match free-tier wording in the body.
 *
 * isOpenCodeFreeError() treats any 429/402 as free-tier, which is right for the
 * anonymous lane where quota really is IP-keyed. On a keyed connection a bare
 * 429 is far more likely an ordinary per-KEY rate limit, and a 402 is a billing
 * block — neither is fixed by changing egress IP, so retrying through a relay
 * just pays for a second full request and recovers nothing.
 *
 * Deliberately leaves isOpenCodeFreeError() untouched so the anonymous lane keeps
 * its existing recovery behaviour.
 */
export async function isOpenCodeZenFreeTierError(response, bodyText = null) {
  if (!response) return false;
  if (bodyText == null) {
    try { bodyText = typeof response.clone === "function" ? await response.clone().text() : await response.text?.(); } catch { bodyText = ""; }
  }
  const lower = String(bodyText || "").toLowerCase();
  const textMatch = OPENCODE_FREE_ERROR_TEXTS.some((needle) => lower.includes(needle.toLowerCase()));
  // A 403 with no readable body still means the free-tier gate rejected us.
  if (response.status === 403 && !lower) return true;
  return textMatch && OPENCODE_FREE_ERROR_STATUSES.includes(response.status);
}

export function hasNativeSessionContext() { return opencodeNativeSessionCache.get() !== null; }
