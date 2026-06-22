import {
  DEFAULT_MODEL,
  DEFAULT_UPSTREAM_BASE_URL,
} from "./constants";
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

export function runtimeConfigFromEnv(): RuntimeConfig {
  return {
    host: process.env.ZODEX_HOST || "127.0.0.1",
    port: Number(process.env.ZODEX_PORT || "31452"),
    upstreamBaseUrl:
      process.env.ZAI_BASE_URL ||
      process.env.ZODEX_UPSTREAM_BASE_URL ||
      DEFAULT_UPSTREAM_BASE_URL,
    apiKey: process.env.ZAI_API_KEY,
    defaultModel: process.env.ZODEX_MODEL || DEFAULT_MODEL,
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
): Promise<Response> {
  if (!config.apiKey) {
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
    const response = await fetch(chatCompletionsUrl(config), {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        "content-type": "application/json",
      },
      body,
    });
    if (response.status !== 429 || attempt === 3) {
      return response;
    }
    lastResponse = response;
    await Bun.sleep(retryDelayMs(response.headers.get("retry-after"), attempt));
  }
  return lastResponse!;
}
