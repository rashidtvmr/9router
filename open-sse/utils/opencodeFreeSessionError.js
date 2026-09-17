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

export function hasNativeSessionContext() { return opencodeNativeSessionCache.get() !== null; }
