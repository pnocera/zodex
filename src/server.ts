import { DEFAULT_MODEL } from "./constants";
import {
  chatCompletionToResponse,
  errorResponse,
  parseChatCompletionSse,
  ResponsesStreamTranslator,
} from "./responses";
import { translateResponsesRequest } from "./translate";
import type {
  ChatCompletionResponse,
  ResponsesRequest,
  RuntimeConfig,
} from "./types";
import { fetchChatCompletions } from "./upstream";

function debugLog(message: string, data?: unknown): void {
  if (process.env.ZODEX_DEBUG !== "1") {
    return;
  }
  if (data === undefined) {
    console.error(`[zodex] ${message}`);
    return;
  }
  console.error(`[zodex] ${message}: ${JSON.stringify(data, null, 2)}`);
}

function json(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data, null, 2), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init?.headers,
    },
  });
}

function models(defaultModel = DEFAULT_MODEL): Response {
  return json({
    object: "list",
    data: [
      {
        id: defaultModel,
        object: "model",
        created: 0,
        owned_by: "z.ai",
      },
    ],
  });
}

function isResponsesPath(pathname: string): boolean {
  return pathname === "/responses" || pathname === "/v1/responses";
}

function isModelsPath(pathname: string): boolean {
  return pathname === "/models" || pathname === "/v1/models";
}

function streamHeaders(): Record<string, string> {
  return {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  };
}

async function responseTextSafely(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function handleResponses(
  request: Request,
  config: RuntimeConfig,
): Promise<Response> {
  let body: ResponsesRequest;
  try {
    body = (await request.json()) as ResponsesRequest;
  } catch {
    return json({ error: { message: "Invalid JSON body" } }, { status: 400 });
  }

  const translated = translateResponsesRequest(body, config.defaultModel);
  debugLog("translated request", {
    model: translated.model,
    stream: translated.stream,
    message_roles: translated.messages.map((message) => message.role),
    tools: translated.tools,
    tool_choice: translated.tool_choice,
    max_tokens: translated.max_tokens,
  });
  const upstream = await fetchChatCompletions(config, translated);

  if (!upstream.ok) {
    const text = await responseTextSafely(upstream);
    debugLog("upstream error", { status: upstream.status, text });
    if (body.stream) {
      const translator = new ResponsesStreamTranslator(body);
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (const event of translator.fail(upstream.status, text)) {
              controller.enqueue(event);
            }
            controller.close();
          },
        }),
        { status: 200, headers: streamHeaders() },
      );
    }
    return json(errorResponse(body, upstream.status, text), {
      status: upstream.status,
    });
  }

  if (body.stream) {
    const translator = new ResponsesStreamTranslator(body);
    return new Response(
      new ReadableStream<Uint8Array>({
        async start(controller) {
          for (const event of translator.start()) {
            controller.enqueue(event);
          }
          try {
            if (!upstream.body) {
              throw new Error("Upstream stream body is empty");
            }
            for await (const chunk of parseChatCompletionSse(upstream.body)) {
              for (const event of translator.applyChunk(chunk)) {
                controller.enqueue(event);
              }
            }
            for (const event of translator.finish()) {
              controller.enqueue(event);
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            debugLog("stream translation error", message);
            for (const event of translator.fail(500, message)) {
              controller.enqueue(event);
            }
          } finally {
            controller.close();
          }
        },
      }),
      { status: 200, headers: streamHeaders() },
    );
  }

  const upstreamJson = (await upstream.json()) as ChatCompletionResponse;
  return json(chatCompletionToResponse(upstreamJson, body), { status: 200 });
}

export function createFetchHandler(config: RuntimeConfig) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, model: config.defaultModel });
    }

    if (request.method === "GET" && isModelsPath(url.pathname)) {
      return models(config.defaultModel);
    }

    if (request.method === "POST" && isResponsesPath(url.pathname)) {
      return handleResponses(request, config);
    }

    return json(
      {
        error: {
          message: `No route for ${request.method} ${url.pathname}`,
        },
      },
      { status: 404 },
    );
  };
}

export function serve(config: RuntimeConfig): Bun.Server<undefined> {
  return Bun.serve({
    hostname: config.host,
    port: config.port,
    fetch: createFetchHandler(config),
  });
}
