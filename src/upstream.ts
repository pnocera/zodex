import {
  DEFAULT_MODEL,
  DEFAULT_UPSTREAM_BASE_URL,
} from "./constants";
import { debugConfigFromEnv, type DebugLogger } from "./debug";
import type { ChatCompletionRequest, RuntimeConfig } from "./types";

class RateLimiter {
  private nextAt = 0;

  constructor(private readonly minIntervalMs: number) {}

  async wait(): Promise<void> {
    const now = Date.now();
    const waitMs = Math.max(0, this.nextAt - now);
    this.nextAt = Math.max(now, this.nextAt) + this.minIntervalMs;
    if (waitMs > 0) {
      await Bun.sleep(waitMs);
    }
  }
}

const limiter = new RateLimiter(200);

type Env = Record<string, string | undefined>;

function numberFromEnv(
  value: string | undefined,
  fallback: number,
): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return parsed;
}

export function runtimeConfigFromEnv(env: Env = process.env): RuntimeConfig {
  const debug = debugConfigFromEnv(env);
  return {
    host: env.ZODEX_HOST || "127.0.0.1",
    port: Number(env.ZODEX_PORT || "31452"),
    upstreamBaseUrl:
      env.ZAI_BASE_URL ||
      env.ZODEX_UPSTREAM_BASE_URL ||
      DEFAULT_UPSTREAM_BASE_URL,
    apiKey: env.SYNTHETIC_API_KEY || env.ZAI_API_KEY,
    defaultModel: env.ZODEX_MODEL || DEFAULT_MODEL,
    debug,
    upstreamFetchTimeoutMs: numberFromEnv(
      env.ZODEX_UPSTREAM_FETCH_TIMEOUT_MS,
      debug.enabled ? 120_000 : 0,
    ),
    streamIdleTimeoutMs: numberFromEnv(
      env.ZODEX_STREAM_IDLE_TIMEOUT_MS,
      debug.enabled ? 120_000 : 0,
    ),
  };
}

export function chatCompletionsUrl(config: RuntimeConfig): string {
  return `${config.upstreamBaseUrl.replace(/\/$/, "")}/chat/completions`;
}

export function retryDelayMs(retryAfterHeader: string | null, attempt: number): number {
  const retryAfterSeconds =
    retryAfterHeader === null ? Number.NaN : Number(retryAfterHeader);
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    return retryAfterSeconds * 1000;
  }
  return 500 * 2 ** attempt;
}

export async function fetchChatCompletions(
  config: RuntimeConfig,
  request: ChatCompletionRequest,
  diagnostics: {
    requestId: string;
    logger: DebugLogger;
    signal?: AbortSignal;
  },
): Promise<Response> {
  const { requestId, logger } = diagnostics;
  if (!config.apiKey) {
    logger.log("upstream.auth.missing", { request_id: requestId });
    return new Response(
      JSON.stringify({
        error: {
          message: "ZAI_API_KEY is not set",
          type: "authentication_error",
        },
      }),
      {
        status: 401,
        headers: { "content-type": "application/json" },
      },
    );
  }

  const body = JSON.stringify(request);
  let lastResponse: Response | undefined;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await limiter.wait();
    const url = chatCompletionsUrl(config);
    const startedAt = Date.now();
    const controller = new AbortController();
    const cleanupAbort = relayAbort(diagnostics.signal, controller);
    const timeout =
      config.upstreamFetchTimeoutMs > 0
        ? setTimeout(() => {
            controller.abort(
              new Error(
                `upstream fetch exceeded ${config.upstreamFetchTimeoutMs}ms`,
              ),
            );
          }, config.upstreamFetchTimeoutMs)
        : undefined;
    logger.log("upstream.fetch.start", () => ({
      request_id: requestId,
      attempt,
      url,
      model: request.model,
      stream: request.stream === true,
      payload_bytes: Buffer.byteLength(body),
      timeout_ms: config.upstreamFetchTimeoutMs || null,
    }));
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.apiKey}`,
          "content-type": "application/json",
        },
        body,
        signal: controller.signal,
      });
    } catch (error) {
      logger.log("upstream.fetch.error", {
        request_id: requestId,
        attempt,
        elapsed_ms: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
      cleanupAbort?.();
    }
    logger.log("upstream.fetch.response", {
      request_id: requestId,
      attempt,
      status: response.status,
      elapsed_ms: Date.now() - startedAt,
      content_type: response.headers.get("content-type"),
      retry_after: response.headers.get("retry-after"),
    });
    if (response.status !== 429 || attempt === 3) {
      return response;
    }
    lastResponse = response;
    const delayMs = retryDelayMs(response.headers.get("retry-after"), attempt);
    logger.log("upstream.fetch.retry", {
      request_id: requestId,
      attempt,
      delay_ms: delayMs,
    });
    await Bun.sleep(delayMs);
  }
  return lastResponse!;
}

function relayAbort(
  source: AbortSignal | undefined,
  target: AbortController,
): (() => void) | undefined {
  if (!source) {
    return undefined;
  }
  if (source.aborted) {
    target.abort(source.reason ?? "zodex request cancelled");
    return undefined;
  }
  const onAbort = () => {
    target.abort(source.reason ?? "zodex request cancelled");
  };
  source.addEventListener("abort", onAbort, { once: true });
  return () => source.removeEventListener("abort", onAbort);
}
