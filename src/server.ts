import { DEFAULT_MODEL } from "./constants";
import { createDebugLogger, type DebugLogger } from "./debug";
import {
  chatCompletionToResponse,
  errorResponse,
  parseChatCompletionSse,
  ResponsesStreamTranslator,
} from "./responses";
import { translateResponsesRequest } from "./translate";
import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  ResponsesRequest,
  RuntimeConfig,
} from "./types";
import { buildToolNameCodec } from "./tool-names";
import { fetchChatCompletions } from "./upstream";

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

function isShutdownPath(pathname: string): boolean {
  return pathname === "/__zodex/shutdown";
}

function streamHeaders(): Record<string, string> {
  return {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  };
}

function requestId(): string {
  return `zdx_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function encodedLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function summarizeResponsesRequest(body: ResponsesRequest): Record<string, unknown> {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const toolTypes = tools.map((tool) =>
    tool && typeof tool === "object" && "type" in tool
      ? String((tool as Record<string, unknown>).type)
      : "unknown",
  );
  const functionToolNames = tools.flatMap((tool) => {
    if (!tool || typeof tool !== "object") {
      return [];
    }
    const record = tool as Record<string, unknown>;
    if (record.type !== "function") {
      return [];
    }
    return typeof record.name === "string" ? [record.name] : [];
  });
  return {
    model: body.model,
    stream: body.stream === true,
    max_output_tokens: body.max_output_tokens,
    previous_response_id: body.previous_response_id ?? null,
    input_kind: Array.isArray(body.input) ? "array" : typeof body.input,
    input_items: Array.isArray(body.input) ? body.input.length : undefined,
    tools: tools.length,
    tool_types: toolTypes,
    function_tool_names: functionToolNames,
    tool_choice: body.tool_choice,
    reasoning: body.reasoning,
  };
}

function summarizeChatRequest(translated: ReturnType<typeof translateResponsesRequest>) {
  return {
    model: translated.model,
    stream: translated.stream === true,
    messages: translated.messages.length,
    message_roles: translated.messages.map((message) => message.role),
    tools: Array.isArray(translated.tools) ? translated.tools.length : 0,
    tool_names: (translated.tools ?? []).flatMap((tool) => {
      if (!tool || typeof tool !== "object") {
        return [];
      }
      const record = tool as Record<string, unknown>;
      const fn = record.function;
      if (!fn || typeof fn !== "object") {
        return [];
      }
      const name = (fn as Record<string, unknown>).name;
      return typeof name === "string" ? [name] : [];
    }),
    tool_choice: translated.tool_choice,
    max_tokens: translated.max_tokens,
    payload_bytes: encodedLength(JSON.stringify(translated)),
  };
}

function summarizeChunk(chunk: ChatCompletionChunk): Record<string, unknown> {
  const choice = chunk.choices?.[0];
  const delta = choice?.delta;
  return {
    finish_reason: choice?.finish_reason ?? null,
    has_content: Boolean(delta?.content),
    has_reasoning: Boolean(delta?.reasoning_content ?? delta?.reasoning),
    tool_calls: delta?.tool_calls?.length ?? 0,
    has_usage: Boolean(chunk.usage),
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
  debug: DebugLogger,
): Promise<Response> {
  const id = requestId();
  const startedAt = Date.now();
  const url = new URL(request.url);
  const rawBody = await request.text();
  debug.log("request.received", () => ({
    request_id: id,
    method: request.method,
    path: url.pathname,
    content_length: request.headers.get("content-length"),
    body_bytes: encodedLength(rawBody),
    user_agent: request.headers.get("user-agent"),
  }));

  let body: ResponsesRequest;
  try {
    body = JSON.parse(rawBody) as ResponsesRequest;
  } catch (error) {
    debug.log("request.invalid_json", {
      request_id: id,
      error: error instanceof Error ? error.message : String(error),
    });
    return json({ error: { message: "Invalid JSON body" } }, { status: 400 });
  }

  debug.log("request.parsed", () => ({
    request_id: id,
    ...summarizeResponsesRequest(body),
  }));
  const toolNames = buildToolNameCodec(body.tools);
  if (toolNames.dropped.length > 0) {
    debug.log("tools.dropped", {
      request_id: id,
      tools: toolNames.dropped,
    });
  }
  const translated = translateResponsesRequest(body, config.defaultModel);
  debug.log("request.translated", () => ({
    request_id: id,
    ...summarizeChatRequest(translated),
  }));
  let upstream: Response;
  try {
    upstream = await fetchChatCompletions(config, translated, {
      requestId: id,
      logger: debug,
      signal: request.signal,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    debug.log("request.upstream_fetch_failed", {
      request_id: id,
      elapsed_ms: Date.now() - startedAt,
      error: message,
    });
    if (body.stream) {
      const translator = new ResponsesStreamTranslator(body);
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (const event of translator.fail(502, message)) {
              controller.enqueue(event);
            }
            controller.close();
          },
        }),
        { status: 200, headers: streamHeaders() },
      );
    }
    return json(errorResponse(body, 502, message), { status: 502 });
  }

  if (!upstream.ok) {
    const text = await responseTextSafely(upstream);
    debug.log("upstream.response.error", {
      request_id: id,
      status: upstream.status,
      elapsed_ms: Date.now() - startedAt,
      text,
    });
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
    const streamAbort = new AbortController();
    let cancelled = false;
    return new Response(
      new ReadableStream<Uint8Array>({
        async start(controller) {
          let upstreamChunks = 0;
          let responseEvents = 0;
          const enqueue = (event: Uint8Array): boolean => {
            if (cancelled) {
              return false;
            }
            controller.enqueue(event);
            return true;
          };
          debug.log("response.stream.start", {
            request_id: id,
            stream_idle_timeout_ms: config.streamIdleTimeoutMs || null,
          });
          for (const event of translator.start()) {
            responseEvents += 1;
            if (!enqueue(event)) {
              return;
            }
          }
          try {
            if (!upstream.body) {
              throw new Error("Upstream stream body is empty");
            }
            for await (const chunk of parseChatCompletionSse(upstream.body, {
              requestId: id,
              logger: debug,
              idleTimeoutMs: config.streamIdleTimeoutMs,
              signal: streamAbort.signal,
            })) {
              if (cancelled) {
                return;
              }
              upstreamChunks += 1;
              if (debug.enabled) {
                const chunkSummary = summarizeChunk(chunk);
                const shouldLogInfo =
                  upstreamChunks === 1 ||
                  upstreamChunks % 25 === 0 ||
                  Boolean(chunkSummary.finish_reason);
                if (debug.trace || shouldLogInfo) {
                  debug.log(
                    "response.stream.upstream_chunk",
                    {
                      request_id: id,
                      upstream_chunks: upstreamChunks,
                      ...chunkSummary,
                    },
                    shouldLogInfo ? "info" : "trace",
                  );
                }
              }
              for (const event of translator.applyChunk(chunk)) {
                responseEvents += 1;
                if (!enqueue(event)) {
                  return;
                }
              }
            }
            if (cancelled) {
              return;
            }
            for (const event of translator.finish()) {
              responseEvents += 1;
              if (!enqueue(event)) {
                return;
              }
            }
            debug.log("response.stream.finish", {
              request_id: id,
              upstream_chunks: upstreamChunks,
              response_events: responseEvents,
              elapsed_ms: Date.now() - startedAt,
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (cancelled) {
              debug.log("response.stream.cancelled", {
                request_id: id,
                upstream_chunks: upstreamChunks,
                response_events: responseEvents,
                elapsed_ms: Date.now() - startedAt,
                error: message,
              });
              return;
            }
            debug.log("response.stream.error", {
              request_id: id,
              upstream_chunks: upstreamChunks,
              response_events: responseEvents,
              elapsed_ms: Date.now() - startedAt,
              error: message,
            });
            for (const event of translator.fail(500, message)) {
              responseEvents += 1;
              if (!enqueue(event)) {
                return;
              }
            }
          } finally {
            debug.log("response.stream.close", {
              request_id: id,
              upstream_chunks: upstreamChunks,
              response_events: responseEvents,
              elapsed_ms: Date.now() - startedAt,
              cancelled,
            });
            if (!cancelled) {
              controller.close();
            }
          }
        },
        cancel(reason) {
          cancelled = true;
          if (!streamAbort.signal.aborted) {
            streamAbort.abort(reason ?? "client cancelled zodex response stream");
          }
          debug.log("response.stream.cancel", {
            request_id: id,
            elapsed_ms: Date.now() - startedAt,
            reason: reason instanceof Error ? reason.message : String(reason),
          });
        },
      }),
      { status: 200, headers: streamHeaders() },
    );
  }

  const upstreamJson = (await upstream.json()) as ChatCompletionResponse;
  debug.log("response.non_stream.finish", {
    request_id: id,
    elapsed_ms: Date.now() - startedAt,
    status: upstream.status,
  });
  return json(chatCompletionToResponse(upstreamJson, body), { status: 200 });
}

export function createFetchHandler(config: RuntimeConfig) {
  const debug = createDebugLogger(config.debug);
  debug.log("server.handler.created", {
    host: config.host,
    port: config.port,
    upstream_base_url: config.upstreamBaseUrl,
    model: config.defaultModel,
    upstream_fetch_timeout_ms: config.upstreamFetchTimeoutMs || null,
    stream_idle_timeout_ms: config.streamIdleTimeoutMs || null,
    debug_file: debug.filePath,
  });
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return json({
        ok: true,
        model: config.defaultModel,
        debug: {
          enabled: config.debug.enabled,
          trace: config.debug.trace,
          file: config.debug.filePath ?? null,
        },
        upstream_fetch_timeout_ms: config.upstreamFetchTimeoutMs,
        stream_idle_timeout_ms: config.streamIdleTimeoutMs,
      });
    }

    if (request.method === "POST" && isShutdownPath(url.pathname)) {
      debug.log("server.shutdown.requested");
      setTimeout(() => process.exit(0), 10);
      return json({ ok: true });
    }

    if (request.method === "GET" && isModelsPath(url.pathname)) {
      return models(config.defaultModel);
    }

    if (request.method === "POST" && isResponsesPath(url.pathname)) {
      return handleResponses(request, config, debug);
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
