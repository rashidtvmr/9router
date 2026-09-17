import crypto from "crypto";
import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { getThinkingLevels } from "../providers/thinkingLevels.js";
import { injectReasoningContent } from "../utils/reasoningContentInjector.js";
import { resolveSessionId } from "../utils/sessionManager.js";
import { isMuseSparkModel } from "../providers/models/helpers.js";
import {
  OPENCODE_FREE_ERROR_STATUSES,
  OPENCODE_FREE_ERROR_TEXTS,
  OPENCODE_NATIVE_SESSION_CACHE,
  OPENCODE_SESSION_RETRY,
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
// How long to keep a cached session context around. Native sessions are
// long-lived but we bound the TTL to avoid replaying a stale/invalidated id.
const NATIVE_SESSION_TTL_MS = OPENCODE_NATIVE_SESSION_CACHE.ttlMs;

// Models served by /zen/v1/responses; every other model stays on /chat/completions.
const RESPONSES_MODELS = new Set([
  "muse-spark-1.2-contributor-free",
  "muse-spark-1.3-contributor-free",
]);

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

    const nativeCtx = opencodeNativeSessionCache.get(NATIVE_SESSION_CACHE_KEY);
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
    const url = isResp
      ? `${retryBase}/zen/v1/responses`
      : `${retryBase}/zen/v1/chat/completions`;

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
    if (isResponsesModel(model)) {
      // Responses API names the output cap max_output_tokens and takes thinking
      // as reasoning:{effort,summary} — normalize the Chat fields at this boundary.
      if (body.max_output_tokens === undefined) {
        if (body.max_completion_tokens !== undefined) body.max_output_tokens = body.max_completion_tokens;
        else if (body.max_tokens !== undefined) body.max_output_tokens = body.max_tokens;
      }
      delete body.max_tokens;
      delete body.max_completion_tokens;
      normalizeOpencodeReasoning(model, body);
    }
    return injectReasoningContent({ provider: this.provider, model, body });
  }

  buildUrl(model) {
    const base = this.config.baseUrl;
    return isResponsesModel(model)
      ? `${base}/zen/v1/responses`
      : `${base}/zen/v1/chat/completions`;
  }

  buildHeaders(credentials, stream = true) {
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
    };
  }
}
