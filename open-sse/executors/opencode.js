import crypto from "crypto";
import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { MEMORY_CONFIG } from "../config/runtimeConfig.js";
import { getThinkingLevels } from "../providers/thinkingLevels.js";
import { injectReasoningContent } from "../utils/reasoningContentInjector.js";
import { resolveSessionId } from "../utils/sessionManager.js";
import { isMuseSparkModel } from "../providers/models/helpers.js";
import { applyFingerprintTools } from "../utils/opencodeFingerprint.js";
import { ANTHROPIC_API_VERSION } from "../providers/shared.js";
import {
  OPENCODE_FREE_SESSION_ROTATION,
  OPENCODE_SESSION_RETRY,
} from "../config/opencodeFreeSession.js";
import { isOpenCodeFreeError } from "../utils/opencodeFreeSessionError.js";
import {
  normalizeResponsesInput,
  clampResponsesCallId,
  coerceResponsesArguments,
  coerceResponsesOutput,
} from "../translator/formats/responsesApi.js";

// OpenCode v2 UA shape: opencode/<channel>/<version>/<client>. Upstream rejects
// the v1 "opencode/1.18.x" form with 403 FreeTierError since 2026-10-14.
const OPENCODE_UA = "opencode/latest/2.0.26/cli";
const OPENCODE_CLIENT = "cli";
const MAX_SESSION_LENGTH = 256;
const MAX_TOOL_NAME_LEN = 128;
const SESSION_HEADER = "x-opencode-session";
const SESSION_FIELD = "_opencodeSession";
export const OPENCODE_SESSION_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
const BASE62_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function hasValidOpencodeVersion(ua) {
  const m = String(ua || "").match(/^opencode\/[a-z0-9-]+\/(\d+)\.\d+\.\d+\/[a-z0-9-]+$/i);
  return !!m && parseInt(m[1], 10) >= 2;
}
// Models served by /inference/v1/responses; every other model stays on /chat/completions.
const RESPONSES_MODELS = new Set([
  "muse-spark-1.2-contributor-free",
  "muse-spark-1.3-contributor-free",
]);
const MESSAGES_MODELS = new Set(["union-alpha"]);

// Process-lifetime probe counters for the anonymous-lane rotation experiment.
// The free tier can reject by session and by egress IP, so a rejected request
// is replayed once from the caller's own egress, then through different relay
// pools; these counters answer "did that recover anything?". Reset on restart —
// telemetry, not accounting.
const rotationStats = {
  attempts: 0,
  recovered: 0,
  exhausted: 0,
  directAttempts: 0,
  directRecovered: 0,
  directExhausted: 0,
};

export function openCodeFreeRotationStats() {
  const {
    attempts,
    recovered,
    exhausted,
    directAttempts,
    directRecovered,
    directExhausted,
  } = rotationStats;
  return {
    attempts,
    recovered,
    exhausted,
    // null while there is nothing to judge, so callers never read 0% as "broken".
    recoveryRate: attempts === 0 ? null : recovered / attempts,
    // The caller's own egress is a separate quota bucket from the relay pools.
    // Keep its hit-rate visible instead of folding it into relay rotation.
    directAttempts,
    directRecovered,
    directExhausted,
    directRecoveryRate: directAttempts === 0 ? null : directRecovered / directAttempts,
  };
}

let lastTimestamp = 0;
let counter = 0;

function unstableRandom() {
  const bytes = crypto.randomBytes(14);
  let randomPart = "";
  for (let i = 0; i < 14; i++) {
    randomPart += BASE62_CHARS[bytes[i] % 62];
  }
  return randomPart;
}

// Session prefix = 12 hex of ~(timeMs * 0x1000 + counter), low 48 bits, like the CLI.
// Upstream decodes it and rejects a non-small counter with 403 FreeTierError
// (live probes: counter 0–16 pass, >=100 fail), so the counter must stay real.
const SESSION_PREFIX_MASK = (1n << 48n) - 1n;
const SESSION_TIME_MASK = (1n << 36n) - 1n;

function descendingTimeHex(time, counterValue) {
  return (~(BigInt(time) * 0x1000n + BigInt(counterValue)) & SESSION_PREFIX_MASK)
    .toString(16)
    .padStart(12, "0");
}

export function generateSessionId(timestamp = Date.now()) {
  if (timestamp !== lastTimestamp) {
    lastTimestamp = timestamp;
    counter = 0;
  }
  counter++;
  return `ses_${descendingTimeHex(timestamp, counter)}${unstableRandom()}`;
}

export function translateSessionId(sessionId, clientTool = "") {
  if (typeof sessionId === "string" && OPENCODE_SESSION_RE.test(sessionId.trim())) {
    return sessionId.trim();
  }
  const digest = crypto
    .createHash("sha256")
    .update(`opencode\0${clientTool || "generic"}\0${sessionId || ""}`)
    .digest();
  // Deterministic time field from the digest, counter pinned to 1 (what the CLI sends).
  const time = BigInt(`0x${digest.subarray(0, 5).toString("hex")}`) & SESSION_TIME_MASK;
  const timeHex = descendingTimeHex(time, 1);
  let randomPart = "";
  for (let i = 6; i < 20; i++) {
    randomPart += BASE62_CHARS[digest[i] % 62];
  }
  return `ses_${timeHex}${randomPart}`;
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

// Upstream free-tier quota is accounted per session. Minting a fresh
// x-opencode-session on every request burns through it and surfaces as
// 429 FreeUsageLimitError with growing reset-after delays, while the real
// CLI reuses one long-lived canonical session per conversation. Mirror
// that: one stable canonical session per downstream identity, evicted
// after MEMORY_CONFIG.sessionTtlMs like the other session stores.
const stableOpencodeSessions = new Map();
const MAX_STABLE_SESSIONS = 1000;
const stableSessionCleanup = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of stableOpencodeSessions) {
    if (now - entry.lastUsed > MEMORY_CONFIG.sessionTtlMs) {
      stableOpencodeSessions.delete(key);
    }
  }
}, MEMORY_CONFIG.sessionCleanupIntervalMs);
if (stableSessionCleanup.unref) stableSessionCleanup.unref();

function identityKey(credentials) {
  const connectionId = credentials?.connectionId || credentials?.id;
  if (connectionId) return `opencode:conn:${String(connectionId).slice(0, 128)}`;
  const raw = credentials?.rawHeaders || {};
  const auth = raw.authorization || raw.Authorization || raw["x-api-key"] || raw["X-Api-Key"] || "";
  if (auth) {
    const digest = crypto.createHash("sha256").update(String(auth)).digest("hex").slice(0, 32);
    return `opencode:auth:${digest}`;
  }
  return "opencode:default";
}

function rememberStableSession(key, sessionId) {
  stableOpencodeSessions.delete(key);
  stableOpencodeSessions.set(key, { sessionId, lastUsed: Date.now() });
  while (stableOpencodeSessions.size > MAX_STABLE_SESSIONS) {
    stableOpencodeSessions.delete(stableOpencodeSessions.keys().next().value);
  }
  return sessionId;
}

export function stableSessionId(credentials) {
  const key = identityKey(credentials);
  const existing = stableOpencodeSessions.get(key);
  if (existing) {
    existing.lastUsed = Date.now();
    stableOpencodeSessions.delete(key);
    stableOpencodeSessions.set(key, existing);
    return existing.sessionId;
  }
  return rememberStableSession(key, generateSessionId());
}

// Replace the cached session for a downstream identity. Called when the
// upstream says the free-tier quota is spent: the old session is a dead quota
// bucket, and reusing it would make every later request pay a 429 before the
// executor even reaches the relay-rotation path.
export function replaceStableSession(credentials, sessionId = generateSessionId()) {
  return rememberStableSession(identityKey(credentials), sessionId);
}

function bodyHasSessionHints(body) {
  try {
    if (!body || typeof body !== "object") return false;
    if (typeof body.session_id === "string" && body.session_id.trim()) return true;
    if (typeof body.conversation_id === "string" && body.conversation_id.trim()) return true;
    if (typeof body.prompt_cache_key === "string" && body.prompt_cache_key.trim()) return true;
    if (body.metadata && typeof body.metadata.user_id === "string" && body.metadata.user_id.trim()) return true;
    if (body.request && body.request.sessionId != null && String(body.request.sessionId) !== "") return true;
    const arr = Array.isArray(body.messages)
      ? body.messages
      : Array.isArray(body.input)
        ? body.input
        : null;
    if (arr) {
      let assistantText = "";
      for (const msg of arr) {
        if (msg?.role === "assistant") {
          const content = msg.content;
          if (typeof content === "string") assistantText += content;
          else if (Array.isArray(content)) {
            for (const part of content) assistantText += part?.text || part?.output || "";
          }
          if (assistantText.length >= 50) return true;
        }
      }
    }
    return false;
  } catch {
    return false;
  }
}

// Strip the thinking suffix "model(level)" so registry lookups hit the base id.
function baseModelId(model) {
  return String(model || "").replace(/\([^()]+\)\s*$/, "").trim();
}

function isResponsesModel(model) {
  const base = baseModelId(model);
  return RESPONSES_MODELS.has(base) || isMuseSparkModel(base);
}

function isMessagesModel(model) {
  return MESSAGES_MODELS.has(baseModelId(model));
}

function resolveOpencodeSession(body, credentials, providerSessionId, clientTool) {
  const headers = credentials?.rawHeaders || {};
  const native = nativeSession(headers);
  if (native) return native;

  let incoming = null;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === SESSION_HEADER) {
      incoming = normalizeSession(value);
      break;
    }
  }

  const hinted = incoming || normalizeSession(providerSessionId);
  if (hinted) return translateSessionId(hinted, clientTool);

  if (credentials?.connectionId || bodyHasSessionHints(body)) {
    let viaManager = null;
    try {
      viaManager = resolveSessionId({
        headers,
        body,
        connectionId: credentials?.connectionId,
        scope: "opencode",
      });
    } catch {
      viaManager = null;
    }
    if (viaManager) return translateSessionId(viaManager, clientTool);
  }

  return stableSessionId(credentials);
}

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

function sanitizeResponsesItems(body) {
  if (!Array.isArray(body.input)) return;
  body.input = body.input.filter((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return true;
    // Strip prior-turn reasoning items: OpenCode Free uses public/pooled credentials
    // (`Bearer public`) routing to an upstream OpenAI/Console account pool.
    // OpenAI Responses API strictly enforces that reasoning `encrypted_content`
    // can only be decrypted by the exact caller/account that issued it; sending it
    // across different accounts or rotating proxy relays triggers:
    // [invalid_request_error] reasoning `encrypted_content` was not issued to this caller (400).
    // Furthermore, under stateless mode (store=false), omitting encrypted_content
    // causes OpenAI to reject the referenced reasoning item as "not found or was deleted".
    // Dropping prior reasoning items allows multi-turn conversations and tool-calling
    // loops to succeed cleanly.
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

function normalizeOpencodeReasoning(model, body) {
  const current = body.reasoning;
  const currentReasoning = current && typeof current === "object" && !Array.isArray(current)
    ? current
    : null;
  const requestedEffort = typeof body.reasoning_effort === "string"
    ? body.reasoning_effort
    : currentReasoning?.effort;
  if (typeof requestedEffort !== "string") return;

  const cleanModel = baseModelId(model || body.model);
  const supportedLevels = getThinkingLevels("opencode", cleanModel);
  let effort = requestedEffort.toLowerCase().trim();
  if ((effort === "max" || effort === "ultra") && supportedLevels?.length && !supportedLevels.includes(effort)) {
    if (effort === "ultra" && supportedLevels.includes("max")) effort = "max";
    else if (supportedLevels.includes("xhigh")) effort = "xhigh";
  }

  body.reasoning = { ...currentReasoning, effort };
  if (!body.reasoning.summary) body.reasoning.summary = "auto";
  delete body.reasoning_effort;
}

// Deep-copy the pre-transform request body so a rotated retry replays the
// original request instead of the mutated (already transformed) one —
// BaseExecutor transforms bodies in place.
function snapshotBody(body) {
  if (!body || typeof body !== "object") return null;
  try {
    return JSON.parse(JSON.stringify(body));
  } catch {
    return null;
  }
}

export class OpenCodeExecutor extends BaseExecutor {
  constructor() {
    super("opencode", PROVIDERS.opencode);
  }

  prepareRequestCredentials({ body, credentials, providerSessionId, clientTool } = {}) {
    const sourceCredentials = credentials || {};
    const session = resolveOpencodeSession(body, sourceCredentials, providerSessionId, clientTool);

    return {
      ...sourceCredentials,
      [SESSION_FIELD]: session,
    };
  }

  transformRequest(model, body, stream, credentials) {
    // `_compact` is a 9router-internal flag (see /api/v1/responses/compact);
    // the upstream rejects unknown body keys, so never ship it.
    if (body && typeof body === "object" && "_compact" in body) delete body._compact;
    if (body && typeof body === "object" && model && !body.model) body.model = model;
    // Zen rejects non-streaming requests on free models with 403 FreeTierError;
    // always stream upstream and let the handler layer aggregate for non-stream clients.
    if (body && typeof body === "object") body.stream = true;
    if (isResponsesModel(model || body?.model) && body && typeof body === "object") {
      // ponytail: chỉ model đã xác nhận auto-only; mở allowlist khi có bằng chứng.
      if ("tool_choice" in body && body.tool_choice !== "auto"
        && this.config.quirks?.forceAutoToolChoiceModels?.includes(baseModelId(model))) {
        body.tool_choice = "auto";
      }
      const normalized = normalizeResponsesInput(body.input);
      if (normalized) body.input = normalized;
      if (!Array.isArray(body.input) || body.input.length === 0) {
        body.input = [{ type: "message", role: "user", content: [{ type: "input_text", text: "..." }] }];
      }
      // Responses API names the output cap max_output_tokens and takes thinking
      // as reasoning:{effort,summary} — normalize the Chat fields at this boundary.
      if (body.max_output_tokens === undefined) {
        if (body.max_completion_tokens !== undefined) body.max_output_tokens = body.max_completion_tokens;
        else if (body.max_tokens !== undefined) body.max_output_tokens = body.max_tokens;
      }
      delete body.max_tokens;
      delete body.max_completion_tokens;
      normalizeOpencodeReasoning(model, body);
      body.stream = true;
      body.store = false;
      normalizeResponsesTools(body);
      sanitizeResponsesItems(body);
      // Free-tier fingerprint tools are required even when an agent client
      // already supplied tools. ZCode/Claude Code requests normally have
      // non-empty tool arrays; skipping cloaking here triggers 403 FreeTierError.
      applyFingerprintTools(body, true);
    } else if (body && typeof body === "object") {
      applyFingerprintTools(body, false);
    }
    return injectReasoningContent({ provider: this.provider, model, body });
  }

  async execute(args) {
    // `_compact` is a 9router-internal flag (see /api/v1/responses/compact); the
    // upstream rejects unknown body keys, so strip it before it ships.
    if (args.body && typeof args.body === "object" && "_compact" in args.body) {
      delete args.body._compact;
    }
    const replayBody = snapshotBody(args.body);
    const credentials = this.prepareRequestCredentials(args);
    const result = await super.execute({ ...args, credentials });

    // Free-tier recovery: on a free-tier rejection replay the request through a
    // different relay pool — the free tier keys quota on the connecting egress
    // IP, so a fresh IP is the lever that can actually recover it.
    if (!OPENCODE_FREE_SESSION_ROTATION.enabled) return result;
    if (!result?.response || result.response.ok) return result;
    if (!(await isOpenCodeFreeError(result.response))) return result;

    const freshSession = replaceStableSession(credentials);
    return this._retryOnRotatedEgress(args, credentials, result, replayBody, freshSession);
  }

  /**
   * Replay a free-tier rejection from a different egress.
   *
   * The caller's own egress is tried first: relay pools can share an exhausted
   * datacenter quota, while the local route may still have capacity. Relay
   * pools are fronted by the edge proxies in `proxyFetch` and addressed with
   * `proxyOptions.vercelRelayUrl` (x-relay-target/x-relay-path), NOT by
   * swapping the request origin — the relay answers a bare origin URL with
   * 400 "missing target". Fail-open: any problem resolving a pool returns the
   * original response untouched.
   */
  async _retryOnRotatedEgress(args, credentials, first, replayBody, freshSession = null) {
    const { log } = args;

    const stripSlash = (value) => String(value || "").replace(/\/+$/, "");
    const currentRelay = stripSlash(args.proxyOptions?.vercelRelayUrl);
    let rotationKey = currentRelay || stripSlash(this.config?.baseUrl);
    const firstStatus = first?.response?.status ?? "unknown";
    const triedRelays = new Set(currentRelay ? [currentRelay] : []);
    let attemptsThisRequest = 0;
    let directAttempted = false;

    // The relay pools share a datacenter quota bucket. The caller's own egress
    // is a separate bucket and is often the only route that still has free-tier
    // capacity. Try it once, before spending the relay retry budget. Only do
    // this when the primary request actually went through a relay: otherwise
    // the primary already was direct and repeating it would just burn quota.
    if (currentRelay) {
      directAttempted = true;
      rotationStats.directAttempts += 1;
      const directSession = freshSession || replaceStableSession(credentials);
      log?.info?.("ROTATE", `opencode free-tier ${firstStatus} on ${args.model}; trying direct egress`);

      try {
        const direct = await super.execute({
          ...args,
          body: replayBody ? JSON.parse(JSON.stringify(replayBody)) : args.body,
          credentials: { ...credentials, [SESSION_FIELD]: directSession },
          proxyOptions: {
            ...(args.proxyOptions || {}),
            vercelRelayUrl: "",
            connectionProxyEnabled: false,
            connectionProxyUrl: "",
            connectionNoProxy: "",
            proxyPoolId: null,
            strictProxy: false,
            // Bypass relay, connection-proxy and environment-proxy routing.
            forceDirect: true,
          },
        });

        if (direct?.response?.ok) {
          rotationStats.directRecovered += 1;
          log?.info?.("ROTATE", `opencode rotation recovered ${args.model} via direct egress`);
          return direct;
        }

        // A genuine 4xx/5xx from direct egress is more useful than the relay's
        // quota 429. Surface it instead of masking it with more retries.
        if (direct?.response && !(await isOpenCodeFreeError(direct.response))) {
          return direct;
        }

        rotationStats.directExhausted += 1;
        log?.warn?.("ROTATE", `opencode direct egress did not recover ${args.model} (${direct?.response?.status ?? "no response"})`);
      } catch (error) {
        rotationStats.directExhausted += 1;
        log?.warn?.("ROTATE", `opencode direct egress failed (${error.message})`);
      }
    }

    const maxAttempts = OPENCODE_SESSION_RETRY?.maxAttempts ?? 1;
    if (maxAttempts <= 0) return first;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      let rotated;
      try {
        rotated = await OPENCODE_FREE_SESSION_ROTATION.rotateUpstream(this.provider, rotationKey);
      } catch (error) {
        log?.warn?.("ROTATE", `opencode rotation skipped: ${error.message}`);
        break;
      }

      const relay = stripSlash(rotated);
      if (!relay || !/^https?:\/\//i.test(relay) || triedRelays.has(relay)) {
        log?.debug?.("ROTATE", `opencode free-tier ${firstStatus} with no alternate relay available`);
        break;
      }

      triedRelays.add(relay);
      attemptsThisRequest += 1;
      rotationStats.attempts += 1;

      // A free-tier rejection means the cached session is a spent quota
      // bucket. Mint a new one for each replay and make it the cached session
      // so later requests do not walk back into the same 429. After a direct
      // attempt the direct session is spent too, so every relay gets a fresh one.
      const session = replaceStableSession(
        credentials,
        attempt === 0 && !directAttempted && freshSession ? freshSession : generateSessionId()
      );
      log?.info?.("ROTATE", `opencode free-tier ${firstStatus} on ${args.model}; retry ${attemptsThisRequest}/${maxAttempts} via relay ${relay}`);

      try {
        const retried = await super.execute({
          ...args,
          body: replayBody ? JSON.parse(JSON.stringify(replayBody)) : args.body,
          credentials: { ...credentials, [SESSION_FIELD]: session },
          proxyOptions: { ...(args.proxyOptions || {}), vercelRelayUrl: relay },
        });
        if (retried?.response?.ok) {
          rotationStats.recovered += 1;
          log?.info?.("ROTATE", `opencode rotation recovered ${args.model} via relay ${relay}`);
          return retried;
        }
        rotationStats.exhausted += 1;
        log?.warn?.("ROTATE", `opencode rotation ${attemptsThisRequest}/${maxAttempts} did not recover ${args.model} (${retried?.response?.status ?? "no response"})`);
      } catch (error) {
        // The replay is strictly best-effort — surface the original failure so a
        // relay problem never masks the real upstream error.
        rotationStats.exhausted += 1;
        log?.warn?.("ROTATE", `opencode rotated retry ${attemptsThisRequest}/${maxAttempts} failed (${error.message})`);
      }

      rotationKey = relay;
    }

    if (attemptsThisRequest > 0) {
      log?.warn?.("ROTATE", `opencode rotation exhausted for ${args.model} after ${attemptsThisRequest} attempt(s); returning original ${firstStatus}`);
    }
    return first;
  }

  // Free tier moved from /zen/v1 to /inference/v1 (OpenCode v2); /zen/v1 now
  // answers every free request with 403 FreeTierError.
  buildUrl(model) {
    const base = this.config.baseUrl;
    if (isResponsesModel(model)) return `${base}/inference/v1/responses`;
    if (isMessagesModel(model)) return `${base}/inference/v1/messages`;
    return `${base}/inference/v1/chat/completions`;
  }

  buildHeaders(credentials, stream = true, url = "") {
    const raw = credentials?.rawHeaders || {};
    const lower = {};
    for (const [k, v] of Object.entries(raw)) lower[k.toLowerCase()] = v;

    const downstreamUa = lower["user-agent"] || "";
    const isOpencodeDownstream = hasValidOpencodeVersion(downstreamUa);

    const session = credentials?.[SESSION_FIELD] || this.prepareRequestCredentials({ credentials })[SESSION_FIELD];

    // Mirrors the v2 CLI. Upstream needs x-opencode-session-id next to
    // x-opencode-session, and rejects any x-opencode-request (v1 only) with 403.
    const headers = {
      "Content-Type": "application/json",
      "Authorization": "Bearer public",
      "User-Agent": isOpencodeDownstream ? downstreamUa : OPENCODE_UA,
      "x-opencode-client": lower["x-opencode-client"] || OPENCODE_CLIENT,
      "x-opencode-session": session,
      "x-opencode-session-id": session,
      "x-session-affinity": session,
      "x-session-id": session,
      "x-opencode-project": lower["x-opencode-project"] || "global",
      "Accept": stream ? "text/event-stream" : "*/*",
    };
    if (url.endsWith("/messages")) headers["anthropic-version"] = ANTHROPIC_API_VERSION;
    return headers;
  }
}
