import crypto from "node:crypto";
import { DefaultExecutor } from "./default.js";
import { resolveSessionId } from "../utils/sessionManager.js";
import { isMuseSparkModel, isOpenCodeFreeModel } from "../providers/models/helpers.js";
import { OPENCODE_ZEN_FREE_ROTATION } from "../config/opencodeFreeSession.js";
import { isOpenCodeZenFreeTierError } from "../utils/opencodeFreeSessionError.js";
import {
  normalizeResponsesInput,
  clampResponsesCallId,
  coerceResponsesArguments,
  coerceResponsesOutput,
} from "../translator/formats/responsesApi.js";

const SESSION_HEADER = "x-opencode-session";
const SESSION_FIELD = "_opencodeZenSession";
const MAX_SESSION_LENGTH = 256;

const RESPONSES_BASE_URL = "https://opencode.ai/zen/v1/responses";
const MAX_TOOL_NAME_LEN = 128;
const OPENCODE_UA = "opencode/1.18.31";
const ZEN_ORIGIN = "https://opencode.ai";

// Per-request carrier for a rotated upstream origin. Executor instances are
// shared singletons (see executors/index.js), so rotation state has to ride on
// the request's credentials — an instance field would leak across concurrent
// requests.
const ROTATED_ORIGIN = Symbol("opencodeZenRotatedOrigin");

// Swaps only the origin so every Zen path (/zen/v1/chat/completions,
// /zen/v1/messages, /zen/v1/responses) keeps working against a relay front.
function withRotatedOrigin(url, origin) {
  if (!origin) return url;
  try {
    const source = new URL(url);
    return `${new URL(origin).origin}${source.pathname}${source.search}`;
  } catch {
    return url;
  }
}

// Process-lifetime probe counters for the keyed-lane rotation experiment.
// The anonymous lane's quota is IP-keyed; a keyed connection may be quota'd
// against the API key instead, in which case rotating the IP recovers nothing.
// These counters answer that empirically instead of by assumption. They reset
// on restart — this is telemetry, not accounting.
const rotationStats = { attempts: 0, recovered: 0, exhausted: 0 };

export function openCodeZenRotationStats() {
  const { attempts, recovered, exhausted } = rotationStats;
  return {
    attempts,
    recovered,
    exhausted,
    // null while there is nothing to judge, so callers never read 0% as "broken".
    recoveryRate: attempts === 0 ? null : recovered / attempts,
  };
}
export const OPENCODE_SESSION_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
const BASE62_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
// Free-tier fingerprint (mirrors opencode executor, PR #4132): upstream 403s
// requests without the file-search quartet and without stream:true.
const OPENCODE_FINGERPRINT_TOOLS = ["bash", "glob", "grep", "read"];

function hasValidOpencodeVersion(ua) {
  const m = String(ua || "").match(/opencode\/(\d+)\.(\d+)(?:\.(\d+))?/i);
  if (!m) return false;
  const major = parseInt(m[1], 10);
  const minor = parseInt(m[2], 10);
  return major > 1 || (major === 1 && minor >= 17);
}

function unstableRandom() {
  const bytes = crypto.randomBytes(14);
  let randomPart = "";
  for (let i = 0; i < 14; i++) {
    randomPart += BASE62_CHARS[bytes[i] % 62];
  }
  return randomPart;
}

export function generateSessionId(timestamp = Date.now()) {
  const current = BigInt(timestamp) * 0x1000n + 1n;
  const value = ~current;
  const time = Array.from({ length: 6 }, (_, index) =>
    Number((value >> BigInt(40 - 8 * index)) & 0xffn)
      .toString(16)
      .padStart(2, "0")
  ).join("");
  return `ses_${time}${unstableRandom()}`;
}

export function generateRequestId(timestamp = Date.now()) {
  const current = BigInt(timestamp) * 0x1000n + 1n;
  const value = current;
  const time = Array.from({ length: 6 }, (_, index) =>
    Number((value >> BigInt(40 - 8 * index)) & 0xffn)
      .toString(16)
      .padStart(2, "0")
  ).join("");
  return `msg_${time}${unstableRandom()}`;
}

export function translateSessionId(sessionId, clientTool = "") {
  if (typeof sessionId === "string" && OPENCODE_SESSION_RE.test(sessionId.trim())) {
    return sessionId.trim();
  }
  const digest = crypto
    .createHash("sha256")
    .update(`opencode\0${clientTool || "generic"}\0${sessionId || ""}`)
    .digest();
  const timeHex = digest.subarray(0, 6).toString("hex");
  let randomPart = "";
  for (let i = 6; i < 20; i++) {
    randomPart += BASE62_CHARS[digest[i] % 62];
  }
  return `ses_${timeHex}${randomPart}`;
}

function toolNameOf(tool) {
  if (!tool || typeof tool !== "object" || Array.isArray(tool)) return "";
  const fn = tool.function && typeof tool.function === "object" && !Array.isArray(tool.function) ? tool.function : null;
  const raw = typeof tool.name === "string" ? tool.name : (typeof fn?.name === "string" ? fn.name : "");
  return raw.trim();
}

function ensureChatFingerprintTools(body) {
  if (!body || typeof body !== "object") return;
  const present = new Set();
  if (Array.isArray(body.tools)) {
    for (const tool of body.tools) {
      const name = toolNameOf(tool);
      if (name) present.add(name);
    }
  } else {
    body.tools = [];
  }
  for (const name of OPENCODE_FINGERPRINT_TOOLS) {
    if (present.has(name)) continue;
    body.tools.push({
      type: "function",
      function: {
        name,
        description: `OpenCode built-in ${name} tool`,
        parameters: { type: "object", properties: {} },
      },
    });
    present.add(name);
  }
}

function ensureResponsesFingerprintTools(body) {
  if (!body || typeof body !== "object") return;
  const present = new Set();
  if (Array.isArray(body.tools)) {
    for (const tool of body.tools) {
      const name = toolNameOf(tool);
      if (name) present.add(name);
    }
  } else {
    body.tools = [];
  }
  for (const name of OPENCODE_FINGERPRINT_TOOLS) {
    if (present.has(name)) continue;
    body.tools.push({
      type: "function",
      name,
      description: `OpenCode built-in ${name} tool`,
      parameters: { type: "object", properties: {} },
    });
    present.add(name);
  }
}

function normalizeSession(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_SESSION_LENGTH) return null;
  return normalized;
}

function nativeSession(headers) {
  if (!headers || typeof headers !== "object") return null;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === SESSION_HEADER) {
      const normalized = normalizeSession(value);
      if (normalized && OPENCODE_SESSION_RE.test(normalized)) return normalized;
    }
  }
  return null;
}

function translatedSession(sessionId, clientTool) {
  return translateSessionId(sessionId, clientTool);
}

// Strip the thinking suffix "model(level)" so checks hit the base id.
function baseModelId(model) {
  return String(model || "").replace(/\([^()]+\)\s*$/, "").trim();
}

function isResponsesModel(model) {
  return isMuseSparkModel(baseModelId(model));
}

// Flatten Chat Completions tool declarations into the Responses flat shape and
// drop hosted/nameless tools the /responses endpoint rejects.
function normalizeResponsesTools(body) {
  if (!Array.isArray(body.tools)) return;
  const validNames = new Set();
  body.tools = body.tools.filter((tool) => {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) return false;
    const fn = tool.function && typeof tool.function === "object" && !Array.isArray(tool.function) ? tool.function : null;
    const rawName = typeof tool.name === "string" ? tool.name : (typeof fn?.name === "string" ? fn.name : "");
    const name = rawName.trim();
    if (!name) return false;
    const description = typeof tool.description === "string" ? tool.description : (typeof fn?.description === "string" ? fn.description : "");
    let parameters = (tool.parameters && typeof tool.parameters === "object" && !Array.isArray(tool.parameters))
      ? tool.parameters
      : (fn?.parameters && typeof fn.parameters === "object" && !Array.isArray(fn.parameters) ? fn.parameters : { type: "object", properties: {} });
    // Mirror the request translator: {type:"object"} without properties is rejected
    // by strict Responses backends, so fill in the empty properties map.
    if (parameters.type === "object" && !parameters.properties) parameters = { ...parameters, properties: {} };
    for (const k of Object.keys(tool)) delete tool[k];
    tool.type = "function";
    tool.name = name.slice(0, MAX_TOOL_NAME_LEN);
    if (description) tool.description = description;
    tool.parameters = parameters;
    validNames.add(tool.name);
    return true;
  });
  if (body.tool_choice && typeof body.tool_choice === "object" && !Array.isArray(body.tool_choice)) {
    if (body.tool_choice.type === "function") {
      const n = typeof body.tool_choice.name === "string" ? body.tool_choice.name.trim() : "";
      if (!n || !validNames.has(n)) delete body.tool_choice;
    }
  }
}

// Last line of defense for native Responses clients (sourceFormat === targetFormat
// skips translation): coerce items in place so malformed tool payloads 400 here
// with a clear shape instead of upstream as InputValidationError.
function sanitizeResponsesItems(body) {
  if (!Array.isArray(body.input)) return;
  body.input = body.input.filter((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return true;
    // Strip prior-turn reasoning items: Muse Spark contributor models route to
    // an upstream Console backend where encrypted_content cannot be validated across
    // rotated accounts or sessions, causing 400 "reasoning encrypted_content was not issued to this caller".
    if (item.type === "reasoning") return false;
    delete item.encrypted_content;
    delete item.reasoning_encrypted_content;
    if (item.type === "function_call") {
      if (!item.name || typeof item.name !== "string" || item.name.trim() === "") return false;
      item.name = item.name.trim().slice(0, MAX_TOOL_NAME_LEN);
      item.call_id = clampResponsesCallId(item.call_id);
      item.arguments = coerceResponsesArguments(item.arguments);
      return true;
    }
    if (item.type === "function_call_output") {
      item.call_id = clampResponsesCallId(item.call_id);
      item.output = coerceResponsesOutput(item.output);
      return true;
    }
    return true;
  });
}

export class OpenCodeZenExecutor extends DefaultExecutor {
  constructor() {
    super("opencode-zen");
  }

  buildUrl(model, stream, urlIndex = 0, credentials = null) {
    // Muse Spark lives on /responses even when a stale runtimeTransport leaks in.
    const url = isResponsesModel(model)
      ? RESPONSES_BASE_URL
      : super.buildUrl(model, stream, urlIndex, credentials);
    return withRotatedOrigin(url, credentials?.[ROTATED_ORIGIN]);
  }

  prepareRequestCredentials({ body, credentials, providerSessionId, clientTool } = {}) {
    const sourceCredentials = credentials || {};
    const native = nativeSession(sourceCredentials.rawHeaders);
    const resolved = normalizeSession(providerSessionId) || resolveSessionId({
      headers: sourceCredentials.rawHeaders,
      body,
      connectionId: sourceCredentials.connectionId,
      scope: "opencode-zen",
    });

    return {
      ...sourceCredentials,
      [SESSION_FIELD]: native || translatedSession(resolved, clientTool),
    };
  }

  async execute(args) {
    const credentials = this.prepareRequestCredentials(args);
    const result = await super.execute({ ...args, credentials });

    if (!OPENCODE_ZEN_FREE_ROTATION.enabled) return result;
    // Only the free tier is plausibly IP-quota'd. A paid model's 429 is a real
    // rate limit, and bouncing it through a relay just adds latency.
    if (!isOpenCodeFreeModel(args.model)) return result;
    if (!result?.response || result.response.ok) return result;
    // Keyed lane: require free-tier wording in the body. A bare 429 here is
    // almost certainly a per-key rate limit, which no amount of IP rotation
    // fixes — see isOpenCodeZenFreeTierError.
    if (!(await isOpenCodeZenFreeTierError(result.response))) return result;

    return this._retryOnRotatedOrigin(args, credentials, result);
  }

  /**
   * Replay a free-tier rejection against a different egress IP.
   *
   * Fail-open throughout: any problem resolving a relay pool, or a rotated
   * origin that turns out to be the one we are already on, returns the
   * original result untouched.
   */
  async _retryOnRotatedOrigin(args, credentials, first) {
    const { log } = args;
    let currentOrigin = ZEN_ORIGIN;
    try {
      currentOrigin = new URL(first.url).origin;
    } catch { /* keep the default */ }

    let rotated;
    try {
      rotated = await OPENCODE_ZEN_FREE_ROTATION.rotateUpstream(this.provider, currentOrigin);
    } catch (error) {
      log?.warn?.("ROTATE", `opencode-zen rotation skipped: ${error.message}`);
      return first;
    }

    let rotatedOrigin;
    try {
      rotatedOrigin = rotated ? new URL(rotated).origin : "";
    } catch {
      rotatedOrigin = "";
    }
    if (!rotatedOrigin || rotatedOrigin === currentOrigin) {
      log?.debug?.("ROTATE", `opencode-zen free-tier ${first.response.status} with no alternate relay available`);
      return first;
    }

    rotationStats.attempts += 1;
    log?.debug?.("ROTATE", `opencode-zen free-tier ${first.response.status} on ${args.model}; retrying via ${rotatedOrigin}`);

    let retried;
    try {
      retried = await super.execute({
        ...args,
        credentials: { ...credentials, [ROTATED_ORIGIN]: rotatedOrigin },
      });
    } catch (error) {
      // The replay is strictly best-effort — surface the original failure so a
      // relay problem never masks the real upstream error.
      rotationStats.exhausted += 1;
      log?.warn?.("ROTATE", `opencode-zen rotated retry failed (${error.message}); returning original response`);
      return first;
    }

    if (retried?.response?.ok) {
      rotationStats.recovered += 1;
      log?.debug?.("ROTATE", `opencode-zen rotation recovered ${args.model} via ${rotatedOrigin}`);
      return retried;
    }

    rotationStats.exhausted += 1;
    log?.debug?.("ROTATE", `opencode-zen rotation did not recover ${args.model} (${retried?.response?.status ?? "no response"})`);
    return first;
  }

  buildHeaders(credentials, stream = true, url, model) {
    const headers = super.buildHeaders(credentials || {}, stream, url, model);
    const raw = credentials?.rawHeaders || {};
    const lower = {};
    for (const [k, v] of Object.entries(raw)) lower[k.toLowerCase()] = v;
    const downstreamUa = lower["user-agent"] || "";
    // Free-tier gate: spoof the official client UA.
    headers["User-Agent"] = hasValidOpencodeVersion(downstreamUa) ? downstreamUa : OPENCODE_UA;
    headers["x-opencode-client"] = lower["x-opencode-client"] || "desktop";
    const prepared = credentials?.[SESSION_FIELD];
    if (prepared) {
      headers[SESSION_HEADER] = prepared;
      return headers;
    }

    const fallback = this.prepareRequestCredentials({ credentials });
    headers[SESSION_HEADER] = fallback[SESSION_FIELD];
    return headers;
  }

  transformRequest(model, body, stream, credentials) {
    const out = super.transformRequest(model, body);
    // Free-tier gate: upstream 403s stream:false even when everything else is valid.
    if (out && typeof out === "object") out.stream = true;
    if (!isResponsesModel(model || body?.model)) {
      ensureChatFingerprintTools(out);
      return out;
    }
    const normalized = normalizeResponsesInput(out.input);
    if (normalized) out.input = normalized;
    if (!Array.isArray(out.input) || out.input.length === 0) {
      out.input = [{ type: "message", role: "user", content: [{ type: "input_text", text: "..." }] }];
    }
    // Responses names the output cap max_output_tokens, not max_tokens.
    if (out.max_output_tokens === undefined) {
      if (out.max_completion_tokens !== undefined) out.max_output_tokens = out.max_completion_tokens;
      else if (out.max_tokens !== undefined) out.max_output_tokens = out.max_tokens;
    }
    delete out.max_tokens;
    delete out.max_completion_tokens;
    if (out.reasoning_effort !== undefined && out.reasoning === undefined) {
      out.reasoning = { effort: out.reasoning_effort, summary: "auto" };
    }
    if (out.reasoning && typeof out.reasoning === "object" && !Array.isArray(out.reasoning)) {
      if (!out.reasoning.summary) out.reasoning.summary = "auto";
    }
    delete out.reasoning_effort;
    out.stream = true;
    out.store = false;
    ensureResponsesFingerprintTools(out);
    normalizeResponsesTools(out);
    sanitizeResponsesItems(out);
    return out;
  }
}
