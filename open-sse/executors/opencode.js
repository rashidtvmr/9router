import crypto from "crypto";
import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { getThinkingLevels } from "../providers/thinkingLevels.js";
import { injectReasoningContent } from "../utils/reasoningContentInjector.js";
import { resolveSessionId } from "../utils/sessionManager.js";
import { isMuseSparkModel } from "../providers/models/helpers.js";
import { applyFingerprintTools } from "../utils/opencodeFingerprint.js";
import { ANTHROPIC_API_VERSION } from "../providers/shared.js";
import {
  normalizeResponsesInput,
  clampResponsesCallId,
  coerceResponsesArguments,
  coerceResponsesOutput,
} from "../translator/formats/responsesApi.js";
import {
  OPENCODE_FREE_ERROR_STATUSES,
  OPENCODE_FREE_ERROR_TEXTS,
  OPENCODE_NATIVE_SESSION_CACHE,
  OPENCODE_SESSION_RETRY,
  OPENCODE_NATIVE_SESSION_BOOTSTRAP,
} from "../config/opencodeFreeSession.js";
import * as freeSessionConfig from "../config/opencodeFreeSession.js";
import { opencodeNativeSessionCache } from "../utils/opencodeNativeSessionCache.js";
import { isOpenCodeFreeError, hasNativeSessionContext } from "../utils/opencodeFreeSessionError.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";

// OpenCode Console rejects the anonymous free-tier token unless the request
// identifies a sufficiently recent OpenCode client. Keep this version at or
// above the upstream minimum even when the caller is a generic OpenAI client.
const OPENCODE_MIN_VERSION = [1, 17, 0];
const OPENCODE_UA = "opencode/1.18.26";
const OPENCODE_SESSION_FIELD = "_opencodeSession";
const OPENCODE_SESSION_HEADER = "x-session-id";
const OPENCODE_SESSION_AFFINITY_HEADER = "x-session-affinity";
const NATIVE_SESSION_CACHE_KEY = "default";
// Single-flight guard: prevents concurrent bootstrap probes for the same
// cache key. Resolves to the cached session entry (or null on failure).
let nativeBootstrapPromise = null;
// How long to keep a cached session context around. Native sessions are
// long-lived but we bound the TTL to avoid replaying a stale/invalidated id.
const NATIVE_SESSION_TTL_MS = OPENCODE_NATIVE_SESSION_CACHE.ttlMs;

// Models served by /zen/v1/responses; every other model stays on /chat/completions.
const RESPONSES_MODELS = new Set([
  "muse-spark-1.2-contributor-free",
  "muse-spark-1.3-contributor-free",
]);
// Claude-format models are served over the native Anthropic messages route.
const MESSAGES_MODELS = new Set(["union-alpha"]);

function generateRequestId() {
  return `msg_${crypto.randomUUID().replace(/-/g, "")}`;
}

function generateSessionId() {
  return `ses_${crypto.randomUUID().replace(/-/g, "")}`;
}

function normalizeHeaderValue(value) {
  if (typeof value !== "string") return "";
  const normalized = value.trim();
  return normalized.length <= 256 ? normalized : "";
}

function hasSupportedOpenCodeVersion(userAgent) {
  const match = /^opencode\/(\d+)\.(\d+)\.(\d+)/i.exec(String(userAgent || "").trim());
  if (!match) return false;
  const version = match.slice(1, 4).map(Number);
  for (let index = 0; index < OPENCODE_MIN_VERSION.length; index += 1) {
    if (version[index] !== OPENCODE_MIN_VERSION[index]) return version[index] > OPENCODE_MIN_VERSION[index];
  }
  return true;
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

function resolveOpencodeSession(body, credentials) {
  const headers = credentials?.rawHeaders || {};
  const native = Object.entries(headers).find(([key]) => key.toLowerCase() === "x-opencode-session")?.[1];
  if (typeof native === "string" && native.trim() && native.trim().length <= 256) return native.trim();

  const providerSessionId = typeof credentials?.providerSessionId === "string"
    ? credentials.providerSessionId.trim()
    : "";
  if (providerSessionId && providerSessionId.length <= 256) return providerSessionId;
  return resolveSessionId({
    headers,
    body,
    connectionId: credentials?.connectionId,
    scope: "opencode",
    generate: generateSessionId,
  });
}

const MAX_TOOL_NAME_LEN = 128;

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

/**
 * Read a config-driven DC rotation hook for the session-retry path.
 * The hook may return a base URL (string) or a promise resolving to one.
 * Returns null when no rotation is configured.
 */
async function resolveRotationBaseUrl() {
  // PROVIDERS contains normalized transport objects. Keep the nested lookup as
  // a compatibility fallback for callers still supplying registry-shaped data.
  const provider = PROVIDERS?.opencode;
  const transport = provider?.sessionRetry ? provider : provider?.transport;
  const sessionRetry = transport?.sessionRetry;
  if (sessionRetry == null) return null;
  const hook = typeof sessionRetry === "object" ? sessionRetry.baseUrlFn : transport.baseUrlFn;
  if (typeof hook !== "function") return null;
  try { return await hook(); } catch { return null; }
}

/**
 * Build headers that replay a cached native session context exactly as the
 * native OpenCode CLI sends them, preserving the original auth token and
 * content-type while overriding the session + user-agent fields.
 */
function buildNativeReplayHeaders(nativeCtx, credentials, stream = true) {
  const apiKey = typeof credentials?.accessToken === "string"
    && credentials.accessToken.trim() !== ""
    && credentials.accessToken !== "public"
    ? credentials.accessToken
    : "public";

  const session = normalizeHeaderValue(nativeCtx.sessionId) || generateSessionId();
  const ua = nativeCtx.userAgent || OPENCODE_UA;

  return {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${apiKey}`,
    "User-Agent": ua,
    "x-opencode-client": "desktop",
    "x-opencode-session": session,
    "x-opencode-request": generateRequestId(),
    "x-opencode-project": "global",
    [OPENCODE_SESSION_HEADER]: session,
    [OPENCODE_SESSION_AFFINITY_HEADER]: session,
    "Accept": stream ? "text/event-stream" : "*/*",
  };
}

export class OpenCodeExecutor extends BaseExecutor {
  constructor() {
    super("opencode", PROVIDERS.opencode);
    this._isCompact = false;
  }

  prepareRequestCredentials({ body, credentials, providerSessionId } = {}) {
    const sourceCredentials = credentials || {};
    return {
      ...sourceCredentials,
      [OPENCODE_SESSION_FIELD]: resolveOpencodeSession(body, {
        ...sourceCredentials,
        providerSessionId,
      }),
    };
  }

  async execute(args) {
    const { model } = args;
    // Capture the compact flag before super.execute() runs transformRequest,
    // which deletes _compact from the body. We need this for the retry path
    // to route compaction requests to the correct endpoint.
    const isCompact = !!(args.body && args.body._compact);
    // Delete _compact before super.execute() so it never reaches upstream in
    // the initial request body. transformRequest also strips it, but we set
    // _isCompact here so it survives even if transformRequest hasn't run yet.
    if (args.body) delete args.body._compact;

    this._isCompact = isCompact;
    const credentials = this.prepareRequestCredentials(args);
    const result = await super.execute({ ...args, credentials });

    // Capture a successful response's session context for future free-tier
    // recovery. We store the request-local session id, the effective UA, and a
    // representative body shape that the native CLI would have sent.
    if (result?.response && result.response.ok) {
      const preparedSession = normalizeHeaderValue(credentials?.[OPENCODE_SESSION_FIELD]);
      const responseSession = normalizeHeaderValue(result.response?.headers?.["x-session-id"] ?? result.response?.headers?.get?.("x-session-id"));
      const session = preparedSession || responseSession;
      if (session) {
        const ua = result.response?.headers?.["user-agent"] || result.response?.headers?.get?.("user-agent") || OPENCODE_UA;
        const bodyForReplay = result.transformedBody
          ? { ...result.transformedBody }
          : null;
        opencodeNativeSessionCache.set(
          { sessionId: session, userAgent: ua, requestBody: bodyForReplay },
          NATIVE_SESSION_CACHE_KEY,
        );
      }
    }

    // Free-tier recovery: if the upstream rejected us, replay using the cached
    // native session context (if available) and optionally rotate the DC.
    if (result?.response && !result.response.ok) {
      const isFreeError = await isOpenCodeFreeError(result.response);
      if (isFreeError) {
        const retryResult = await this._retryWithNativeSession(args, credentials, model);
        if (retryResult) return retryResult;
      }
    }

    return result;
  }

  async bootstrapNativeSession(credentials, log) {
    const cached = opencodeNativeSessionCache.get(NATIVE_SESSION_CACHE_KEY);
    if (cached) return cached;
    if (nativeBootstrapPromise) return nativeBootstrapPromise;

    nativeBootstrapPromise = (async () => {
      const url = `${this.config.baseUrl}/zen/v1/chat/completions`;
      const headers = this.buildHeaders(credentials, false);
      const requestBody = {
        model: "big-pickle",
        messages: [{ role: "user", content: OPENCODE_NATIVE_SESSION_BOOTSTRAP.probeMessage }],
        max_tokens: OPENCODE_NATIVE_SESSION_BOOTSTRAP.maxTokens,
        stream: false,
      };
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), OPENCODE_NATIVE_SESSION_BOOTSTRAP.timeoutMs);
      try {
        const response = await proxyAwareFetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(requestBody),
          signal: controller.signal,
        });
        const sessionId = normalizeHeaderValue(response?.headers?.get?.(OPENCODE_SESSION_HEADER)
          || response?.headers?.[OPENCODE_SESSION_HEADER]);
        if (!response?.ok || !sessionId) return null;
        const entry = { sessionId, userAgent: headers["User-Agent"], requestBody };
        opencodeNativeSessionCache.set(entry, NATIVE_SESSION_CACHE_KEY);
        return entry;
      } catch (error) {
        log?.debug?.("BOOTSTRAP", `OpenCode native session bootstrap failed: ${error.message}`);
        return null;
      } finally {
        clearTimeout(timer);
      }
    })().finally(() => {
      nativeBootstrapPromise = null;
    });
    return nativeBootstrapPromise;
  }

  /**
   * Replay the failed request using the cached native session context.
   *
   * @param {object} args - Original execute args (model, body, stream, etc.)
   * @param {object} credentials - Resolved credentials with session id
   * @param {string} model - Model being requested
   * @returns {Promise<{response,url,headers,transformedBody}|null>}
   */
  async _retryWithNativeSession(args, credentials, model) {
    const { maxAttempts, delayMs } = OPENCODE_SESSION_RETRY;
    if (maxAttempts <= 0) return null;

    // Cold-start recovery: if no native session is cached yet (fresh install),
    // attempt a bootstrap probe before giving up. The bootstrap caches a native
    // session context that we can then replay with on a fresh egress IP.
    let nativeCtx = opencodeNativeSessionCache.get(NATIVE_SESSION_CACHE_KEY);
    if (!nativeCtx && OPENCODE_NATIVE_SESSION_BOOTSTRAP.enabled) {
      const accessToken = credentials?.accessToken;
      const isFreeTier = accessToken == null || accessToken === "" || accessToken === "public";
      if (isFreeTier) {
        try {
          await this.bootstrapNativeSession(credentials, args.log);
        } catch { /* fail open — bootstrap is best-effort */ }
        nativeCtx = opencodeNativeSessionCache.get(NATIVE_SESSION_CACHE_KEY);
      }
    }
    if (!nativeCtx) return null;

    const { body, stream, signal, log, proxyOptions } = args;

    // Determine the base URL for the retry: config-driven rotation hook first,
    // then fall back to the original config base URL.
    const currentBase = this.config.baseUrl;
    let retryBase = currentBase;

    // 1. Provider transport's sessionRetry.baseUrlFn (legacy hook point).
    const providerRotationBase = await resolveRotationBaseUrl();

    // 2. Config-driven rotateUpstream (cycles Lambda relay IPs for egress
    //    diversity — the primary hook for OpenCode free-tier DC rotation).
    const rotateUpstream = freeSessionConfig.OPENCODE_FREE_SESSION_ROTATION?.rotateUpstream
      || this.config?.sessionRotation?.rotateUpstream;

    if (providerRotationBase && providerRotationBase !== currentBase) {
      retryBase = providerRotationBase;
    } else if (typeof rotateUpstream === "function") {
      try { retryBase = await (rotateUpstream(this.provider, currentBase) || currentBase); } catch { /* fail open */ }
    }

    // Build the native-replay URL and headers.
    const isResp = isResponsesModel(model);
    const compactSuffix = this._isCompact ? "/compact" : "";
    const url = isResp
      ? `${retryBase}/zen/v1/responses${compactSuffix}`
      : `${retryBase}/zen/v1/chat/completions${compactSuffix}`;

    // Transform the body the same way the happy path does (fresh clone so we
    // don't mutate the caller's object again).
    if (!body || typeof body !== "object" || Array.isArray(body) || !Array.isArray(body.messages)) return null;
    const template = nativeCtx.nativeBody || nativeCtx.requestBody;
    const bodyClone = template && typeof template === "object" ? JSON.parse(JSON.stringify(template)) : {};
    Object.assign(bodyClone, JSON.parse(JSON.stringify(body)));
    bodyClone.model = model;
    bodyClone.messages = body.messages;
    bodyClone.stream = stream !== false;
    bodyClone.store = false;
    // Ensure _compact is stripped from the retry body (it may persist from
    // the original body since we only deleted it on args.body, not a deep copy).
    delete bodyClone._compact;
    if (bodyClone.tool_choice === undefined) bodyClone.tool_choice = "auto";
    const transformedBody = this.transformRequest(model, bodyClone, stream, credentials);
    const nativeHeaders = this.buildCachedHeaders(nativeCtx, credentials, stream);

    log?.debug?.("RETRY", `OpenCode free-tier error, replaying native session ${nativeCtx.sessionId?.slice(0, 20)}… on ${url}`);

    // Wait before retry (configurable delay, default 0).
    const waitMs = typeof delayMs === "number" && delayMs > 0 ? delayMs : 0;
    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }

    // Single retry attempt (OPENCODE_SESSION_RETRY.maxAttempts is 1).
    const connectCtrl = new AbortController();
    const connectTimer = setTimeout(
      () => connectCtrl.abort(new Error("fetch connect timeout")),
      this.config?.timeoutMs || 60000,
    );
    const mergedSignal = signal ? AbortSignal.any([signal, connectCtrl.signal]) : connectCtrl.signal;

    try {
      const response = await proxyAwareFetch(url, {
        method: "POST",
        headers: nativeHeaders,
        body: JSON.stringify(transformedBody),
        signal: mergedSignal,
      }, proxyOptions);
      clearTimeout(connectTimer);

      // If the retry succeeds, update the cache timestamp by refreshing the
      // entry with the same context (keeps it alive for the next caller).
      if (response.ok) {
        opencodeNativeSessionCache.set(
          { sessionId: nativeCtx.sessionId, userAgent: nativeCtx.userAgent, requestBody: null },
          NATIVE_SESSION_CACHE_KEY,
        );
      }

      return { response, url, headers: nativeHeaders, transformedBody };
    } catch (error) {
      clearTimeout(connectTimer);
      log?.warn?.("RETRY", `OpenCode native session replay failed: ${error.message}`);
      return null;
    }
  }

  buildCachedHeaders(nativeCtx, credentials, stream = true) {
    return buildNativeReplayHeaders(nativeCtx, credentials, stream);
  }

  transformRequest(model, body, stream, credentials) {
    // Capture the compact flag before it gets sent upstream (OpenCode's zen API
    // does not understand the internal _compact field and rejects the request
    // with FreeTierError when it sees an unrecognised body key from a non-native
    // client). The flag is consumed by buildUrl to route to the compact endpoint.
    // Only set _isCompact if the field is present, so the retry path (which
    // rebuilds the body without _compact) doesn't clobber the flag captured
    // during execute().
    if (body && "_compact" in body) {
      this._isCompact = !!body._compact;
      delete body._compact;
    }

    if (isResponsesModel(model)) {
      // ponytail: chỉ model đã xác nhận auto-only; mở allowlist khi có bằng chứng.
      if ("tool_choice" in body && body.tool_choice !== "auto"
        && this.config.quirks?.forceAutoToolChoiceModels?.includes(baseModelId(model))) {
        body.tool_choice = "auto";
      }
      const normalizedInput = normalizeResponsesInput(body.input);
      if (normalizedInput) body.input = normalizedInput;
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

  buildUrl(model) {
    const base = this.config.baseUrl;
    const isCompact = this._isCompact;
    if (isResponsesModel(model)) {
      const baseResp = `${base}/zen/v1/responses`;
      return isCompact ? `${baseResp}/compact` : baseResp;
    }
    if (isMessagesModel(model)) {
      return `${base}/zen/v1/messages`;
    }
    const baseChat = `${base}/zen/v1/chat/completions`;
    return isCompact ? `${baseChat}/compact` : baseChat;
  }

  buildHeaders(credentials, stream = true, url = "") {
    const raw = credentials?.rawHeaders || {};
    const lower = {};
    for (const [k, v] of Object.entries(raw)) lower[k.toLowerCase()] = v;

    const downstreamUa = lower["user-agent"] || "";
    const isOpencodeDownstream = hasSupportedOpenCodeVersion(downstreamUa);
    const session = credentials?.[OPENCODE_SESSION_FIELD]
      || normalizeHeaderValue(lower["x-opencode-session"])
      || normalizeHeaderValue(lower[OPENCODE_SESSION_HEADER])
      || generateSessionId();

    // Keyed connections (real API key) get keyed quota upstream; anonymous
    // free tier rides the "public" token.
    const apiKey = typeof credentials?.accessToken === "string"
      && credentials.accessToken.trim() !== ""
      && credentials.accessToken !== "public"
      ? credentials.accessToken
      : "public";

    return {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
      "User-Agent": isOpencodeDownstream ? downstreamUa : OPENCODE_UA,
      "x-opencode-client": lower["x-opencode-client"] || "desktop",
      "x-opencode-session": session,
      "x-opencode-request": lower["x-opencode-request"] || generateRequestId(),
      "x-opencode-project": lower["x-opencode-project"] || "global",
      // OpenCode's anonymous Console tier validates native session context.
      // The CLI sends both headers with the same stable session id.
      [OPENCODE_SESSION_HEADER]: normalizeHeaderValue(lower[OPENCODE_SESSION_HEADER]) || session,
      [OPENCODE_SESSION_AFFINITY_HEADER]: normalizeHeaderValue(lower[OPENCODE_SESSION_AFFINITY_HEADER]) || session,
      "Accept": stream ? "text/event-stream" : "*/*",
      ...(url?.endsWith("/messages") ? { "anthropic-version": ANTHROPIC_API_VERSION } : {}),
    };
  }
}
