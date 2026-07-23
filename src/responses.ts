import { DEFAULT_MODEL } from "./constants";
import type { DebugLogger } from "./debug";
import { messageId, reasoningId, responseId, toolCallId } from "./ids";
import { buildToolNameCodec, type DecodedToolName } from "./tool-names";
import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  ChatToolCallDelta,
  ResponsesRequest,
} from "./types";

interface ResponseEnvelopeOptions {
  request: ResponsesRequest;
  model?: string;
  id?: string;
  status?: "in_progress" | "completed" | "failed";
  output?: unknown[];
  usage?: unknown;
  error?: unknown;
}

function reasoningItem(id: string, text: string, status?: string): Record<string, unknown> {
  return {
    id,
    type: "reasoning",
    ...(status ? { status } : {}),
    encrypted_content: null,
    summary: text ? [{ type: "summary_text", text }] : [],
  };
}

function functionCallItem(
  id: string,
  decoded: DecodedToolName,
  args: string,
  status: "in_progress" | "completed" | "incomplete",
): Record<string, unknown> {
  return {
    type: "function_call",
    id,
    call_id: id,
    ...(decoded.namespace ? { namespace: decoded.namespace } : {}),
    name: decoded.name,
    arguments: args,
    status,
  };
}

function normalizeUsage(usage: unknown): unknown {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) {
    return null;
  }
  const raw = usage as Record<string, unknown>;
  const inputTokens = Number(raw.input_tokens ?? raw.prompt_tokens ?? 0);
  const outputTokens = Number(raw.output_tokens ?? raw.completion_tokens ?? 0);
  const totalTokens = Number(raw.total_tokens ?? inputTokens + outputTokens);
  const promptDetails =
    raw.prompt_tokens_details &&
    typeof raw.prompt_tokens_details === "object" &&
    !Array.isArray(raw.prompt_tokens_details)
      ? (raw.prompt_tokens_details as Record<string, unknown>)
      : {};
  const completionDetails =
    raw.completion_tokens_details &&
    typeof raw.completion_tokens_details === "object" &&
    !Array.isArray(raw.completion_tokens_details)
      ? (raw.completion_tokens_details as Record<string, unknown>)
      : {};

  return {
    input_tokens: inputTokens,
    input_tokens_details: {
      cached_tokens: Number(promptDetails.cached_tokens ?? 0),
    },
    output_tokens: outputTokens,
    output_tokens_details: {
      reasoning_tokens: Number(completionDetails.reasoning_tokens ?? 0),
    },
    total_tokens: totalTokens,
  };
}

export function responseObject(
  options: ResponseEnvelopeOptions,
): Record<string, unknown> {
  return {
    id: options.id ?? responseId(),
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: options.status ?? "completed",
    error: options.error ?? null,
    incomplete_details: null,
    instructions: options.request.instructions ?? null,
    max_output_tokens: options.request.max_output_tokens ?? null,
    model: options.model ?? options.request.model ?? DEFAULT_MODEL,
    output: options.output ?? [],
    parallel_tool_calls: options.request.parallel_tool_calls ?? true,
    previous_response_id: options.request.previous_response_id ?? null,
    reasoning: options.request.reasoning ?? { effort: null, summary: null },
    store: options.request.store ?? true,
    temperature: options.request.temperature ?? null,
    text: options.request.text ?? { format: { type: "text" } },
    tool_choice: options.request.tool_choice ?? "auto",
    tools: options.request.tools ?? [],
    top_p: options.request.top_p ?? null,
    truncation: options.request.truncation ?? "disabled",
    usage: normalizeUsage(options.usage),
    user: options.request.user ?? null,
    metadata: options.request.metadata ?? {},
  };
}

export function chatCompletionToResponse(
  chat: ChatCompletionResponse,
  request: ResponsesRequest,
): Record<string, unknown> {
  const choice = chat.choices?.[0];
  const message = choice?.message;
  const output: unknown[] = [];

  const reasoning = message?.reasoning_content ?? message?.reasoning;
  if (reasoning) {
    output.push(reasoningItem(reasoningId(), String(reasoning)));
  }

  if (message?.content) {
    output.push({
      id: messageId(),
      type: "message",
      status: "completed",
      role: "assistant",
      content: [
        {
          type: "output_text",
          text: message.content,
          annotations: [],
        },
      ],
    });
  }

  const toolNames = buildToolNameCodec(request.tools);
  for (const call of message?.tool_calls ?? []) {
    // Some OpenAI-compatible upstreams omit the tool-call id for a single call.
    // Synthesize one (as the streaming path does) so Codex can correlate the
    // later function_call_output; otherwise call_id would be undefined.
    const id = call.id || toolCallId();
    output.push(
      functionCallItem(
        id,
        toolNames.decode(call.function.name),
        call.function.arguments,
        "completed",
      ),
    );
  }

  return responseObject({
    request,
    id: chat.id,
    model: chat.model,
    status: "completed",
    output,
    usage: chat.usage,
  });
}

export function errorResponse(
  request: ResponsesRequest,
  status: number,
  message: string,
): Record<string, unknown> {
  return responseObject({
    request,
    status: "failed",
    error: {
      type: "upstream_error",
      code: errorCodeForStatus(status),
      message,
    },
  });
}

function errorCodeForStatus(status: number): string {
  if (status === 429) {
    return "rate_limit_exceeded";
  }
  if (status === 503 || status === 529) {
    return "server_is_overloaded";
  }
  if (status >= 400 && status < 500) {
    return "invalid_prompt";
  }
  return String(status);
}

function sse(event: Record<string, unknown>): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

function splitArgumentDelta(delta: string): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < delta.length; i += 10) {
    chunks.push(delta.slice(i, i + 10));
  }
  return chunks.length ? chunks : [""];
}

function computeAppendDelta(current: string, incoming: string): string {
  if (!incoming) {
    return "";
  }
  if (current && incoming.length > current.length && incoming.startsWith(current)) {
    return incoming.slice(current.length);
  }
  return incoming;
}

function repairJsonArguments(argumentsText: string): string {
  if (!argumentsText.trim()) {
    return argumentsText;
  }
  try {
    JSON.parse(argumentsText);
    return argumentsText;
  } catch {
    let repaired = argumentsText.trim().replace(/,\s*([}\]])/g, "$1");
    const opens = {
      brace: (repaired.match(/{/g) ?? []).length,
      bracket: (repaired.match(/\[/g) ?? []).length,
    };
    const closes = {
      brace: (repaired.match(/}/g) ?? []).length,
      bracket: (repaired.match(/]/g) ?? []).length,
    };
    if (closes.bracket < opens.bracket) {
      repaired += "]".repeat(opens.bracket - closes.bracket);
    }
    if (closes.brace < opens.brace) {
      repaired += "}".repeat(opens.brace - closes.brace);
    }
    try {
      JSON.parse(repaired);
      return repaired;
    } catch {
      return argumentsText;
    }
  }
}

interface ToolState {
  id: string;
  name: string;
  namespace?: string;
  arguments: string;
  outputIndex: number;
  nameDone: boolean;
  done: boolean;
}

interface StreamReader {
  read(): Promise<StreamReadResult>;
  cancel(reason?: unknown): Promise<unknown>;
}

type StreamReadResult =
  | { done: false; value: Uint8Array }
  | { done: true; value?: Uint8Array };

export class ResponsesStreamTranslator {
  private sequence = 0;
  private readonly id = responseId();
  private readonly encoder = new TextEncoder();
  private readonly output: unknown[] = [];
  private readonly toolsById = new Map<string, ToolState>();
  private readonly toolIdByIndex = new Map<number, string>();
  private readonly syntheticToolIds = new Set<string>();
  private readonly toolNames;
  private nextOutputIndex = 0;
  private text = "";
  private textItemId = "";
  private textOutputIndex = -1;
  private textStarted = false;
  private textDone = false;
  private reasoning = "";
  private reasoningItemId = "";
  private reasoningOutputIndex = -1;
  private reasoningStarted = false;
  private reasoningDone = false;
  private usage: unknown = null;
  private failure: { status: number; message: string } | null = null;
  private finished = false;

  constructor(
    private readonly request: ResponsesRequest,
    private readonly logger?: DebugLogger,
  ) {
    this.toolNames = buildToolNameCodec(request.tools);
  }

  start(): Uint8Array[] {
    return [
      this.emit("response.created", {
        response: responseObject({
          request: this.request,
          id: this.id,
          status: "in_progress",
        }),
      }),
      this.emit("response.in_progress", {
        response: responseObject({
          request: this.request,
          id: this.id,
          status: "in_progress",
        }),
      }),
    ];
  }

  applyChunk(chunk: ChatCompletionChunk): Uint8Array[] {
    const events: Uint8Array[] = [];
    if (chunk.usage) {
      this.usage = chunk.usage;
    }
    const delta = chunk.choices?.[0]?.delta;
    const finishReason = chunk.choices?.[0]?.finish_reason;
    if (finishReason === "content_filter") {
      this.failure = {
        status: 400,
        message: "Upstream response stopped by content_filter",
      };
    }
    if (!delta) {
      return events;
    }

    const reasoning = delta.reasoning_content ?? delta.reasoning;
    if (reasoning) {
      events.push(...this.reasoningDelta(String(reasoning)));
    }
    if (delta.content) {
      events.push(...this.textDelta(delta.content));
    }
    if (delta.tool_calls?.length) {
      for (const toolDelta of delta.tool_calls) {
        events.push(...this.toolDelta(toolDelta));
      }
    }
    return events;
  }

  finish(): Uint8Array[] {
    // Exactly one terminal event per stream: a second finish()/fail() is a no-op
    // so callers can never emit a duplicate response.completed/response.failed.
    if (this.finished) {
      return [];
    }
    if (this.failure) {
      return this.fail(this.failure.status, this.failure.message);
    }
    this.finished = true;
    const events = this.closeOpenItems(false);
    events.push(
      this.emit("response.completed", {
        response: responseObject({
          request: this.request,
          id: this.id,
          status: "completed",
          // filter(Boolean) is defensive: in the success path every started item
          // is assigned by index in closeOpenItems, so there are no holes.
          output: this.output.filter(Boolean),
          usage: this.usage,
        }),
      }),
    );
    events.push(this.encoder.encode("data: [DONE]\n\n"));
    return events;
  }

  fail(status: number, message: string): Uint8Array[] {
    if (this.finished) {
      return [];
    }
    this.finished = true;
    // Close any output items that were opened before the failure so the event
    // stream stays balanced (every output_item.added / *_part.added gets a
    // matching *.done) before the terminal response.failed.
    const events = this.closeOpenItems(true);
    events.push(
      this.emit("response.failed", {
        response: errorResponse(this.request, status, message),
      }),
    );
    events.push(this.encoder.encode("data: [DONE]\n\n"));
    return events;
  }

  // Emit the closing `.done` events for every in-progress reasoning/text/tool
  // item. Shared by finish() (normal completion) and fail() (mid-stream error),
  // so a failed stream never leaves a dangling added-without-done item. When
  // `failed` is true the items are closed with an "incomplete" status.
  private closeOpenItems(failed: boolean): Uint8Array[] {
    const events: Uint8Array[] = [];
    const itemStatus = failed ? "incomplete" : "completed";

    if (this.reasoningStarted && !this.reasoningDone) {
      events.push(
        this.emit("response.reasoning_summary_text.done", {
          item_id: this.reasoningItemId,
          output_index: this.reasoningOutputIndex,
          summary_index: 0,
          text: this.reasoning,
        }),
      );
      // Close the reasoning_summary_part opened in reasoningDelta so every
      // *_part.added has a matching *_part.done (mirrors the text path's
      // content_part.done, and matches the OpenAI event ordering: text.done
      // then part.done then output_item.done).
      events.push(
        this.emit("response.reasoning_summary_part.done", {
          item_id: this.reasoningItemId,
          output_index: this.reasoningOutputIndex,
          summary_index: 0,
          part: { type: "summary_text", text: this.reasoning },
        }),
      );
      const item = reasoningItem(
        this.reasoningItemId,
        this.reasoning,
        failed ? "incomplete" : undefined,
      );
      this.output[this.reasoningOutputIndex] = item;
      events.push(
        this.emit("response.output_item.done", {
          output_index: this.reasoningOutputIndex,
          item,
        }),
      );
      this.reasoningDone = true;
    }

    if (this.textStarted && !this.textDone) {
      events.push(
        this.emit("response.output_text.done", {
          item_id: this.textItemId,
          output_index: this.textOutputIndex,
          content_index: 0,
          text: this.text,
        }),
      );
      const item = {
        id: this.textItemId,
        type: "message",
        status: itemStatus,
        role: "assistant",
        content: [
          { type: "output_text", text: this.text, annotations: [] },
        ],
      };
      events.push(
        this.emit("response.content_part.done", {
          item_id: this.textItemId,
          output_index: this.textOutputIndex,
          content_index: 0,
          part: item.content[0],
        }),
      );
      events.push(
        this.emit("response.output_item.done", {
          output_index: this.textOutputIndex,
          item,
        }),
      );
      this.output[this.textOutputIndex] = item;
      this.textDone = true;
    }

    for (const tool of this.toolsById.values()) {
      if (tool.done) {
        continue;
      }
      const repaired = repairJsonArguments(tool.arguments);
      if (repaired !== tool.arguments) {
        this.logger?.log(
          "tool.arguments.repaired",
          {
            item_id: tool.id,
            original_length: tool.arguments.length,
            repaired_length: repaired.length,
          },
          "trace",
        );
      }
      tool.arguments = repaired;
      events.push(
        this.emit("response.function_call_arguments.done", {
          item_id: tool.id,
          output_index: tool.outputIndex,
          arguments: tool.arguments,
        }),
      );
      const item = functionCallItem(
        tool.id,
        { namespace: tool.namespace, name: tool.name },
        tool.arguments,
        failed ? "incomplete" : "completed",
      );
      this.output[tool.outputIndex] = item;
      events.push(
        this.emit("response.output_item.done", {
          output_index: tool.outputIndex,
          item,
        }),
      );
      tool.done = true;
    }

    return events;
  }

  private textDelta(delta: string): Uint8Array[] {
    const events: Uint8Array[] = [];
    const append = computeAppendDelta(this.text, delta);
    if (!append) {
      return events;
    }
    if (!this.textStarted) {
      this.textStarted = true;
      this.textItemId = messageId();
      this.textOutputIndex = this.nextOutputIndex++;
      events.push(
        this.emit("response.output_item.added", {
          output_index: this.textOutputIndex,
          item: {
            id: this.textItemId,
            type: "message",
            status: "in_progress",
            role: "assistant",
            content: [],
          },
        }),
      );
      events.push(
        this.emit("response.content_part.added", {
          item_id: this.textItemId,
          output_index: this.textOutputIndex,
          content_index: 0,
          part: { type: "output_text", text: "", annotations: [] },
        }),
      );
    }
    this.text += append;
    events.push(
      this.emit("response.output_text.delta", {
        item_id: this.textItemId,
        output_index: this.textOutputIndex,
        content_index: 0,
        delta: append,
      }),
    );
    return events;
  }

  private reasoningDelta(delta: string): Uint8Array[] {
    const events: Uint8Array[] = [];
    if (!this.reasoningStarted) {
      this.reasoningStarted = true;
      this.reasoningItemId = reasoningId();
      this.reasoningOutputIndex = this.nextOutputIndex++;
      events.push(
        this.emit("response.output_item.added", {
          output_index: this.reasoningOutputIndex,
          item: {
            id: this.reasoningItemId,
            type: "reasoning",
            status: "in_progress",
            encrypted_content: null,
            summary: [],
          },
        }),
      );
      events.push(
        this.emit("response.reasoning_summary_part.added", {
          item_id: this.reasoningItemId,
          output_index: this.reasoningOutputIndex,
          summary_index: 0,
          part: { type: "summary_text", text: "" },
        }),
      );
    }
    this.reasoning += delta;
    events.push(
      this.emit("response.reasoning_summary_text.delta", {
        item_id: this.reasoningItemId,
        output_index: this.reasoningOutputIndex,
        summary_index: 0,
        delta,
      }),
    );
    return events;
  }

  private toolDelta(delta: ChatToolCallDelta): Uint8Array[] {
    const events: Uint8Array[] = [];
    const index = delta.index ?? 0;
    const incomingId = delta.id && delta.id.length > 0 ? delta.id : undefined;
    const existingId = this.toolIdByIndex.get(index);
    let id = existingId ?? incomingId ?? `call_${index}`;
    if (!existingId && !incomingId) {
      this.syntheticToolIds.add(id);
    } else if (
      existingId &&
      incomingId &&
      existingId !== incomingId &&
      this.syntheticToolIds.has(existingId)
    ) {
      const existingTool = this.toolsById.get(existingId);
      if (existingTool) {
        this.toolsById.delete(existingId);
        existingTool.id = incomingId;
        this.toolsById.set(incomingId, existingTool);
      }
      this.syntheticToolIds.delete(existingId);
      id = incomingId;
    }
    this.toolIdByIndex.set(index, id);

    let tool = this.toolsById.get(id);
    if (!tool) {
      const decoded = this.toolNames.decode(delta.function?.name ?? "");
      tool = {
        id,
        name: decoded.name,
        namespace: decoded.namespace,
        arguments: "",
        outputIndex: this.nextOutputIndex++,
        nameDone: false,
        done: false,
      };
      this.toolsById.set(id, tool);
      events.push(
        this.emit("response.output_item.added", {
          output_index: tool.outputIndex,
          item: {
            type: "function_call",
            id,
            call_id: id,
            ...(tool.namespace ? { namespace: tool.namespace } : {}),
            name: tool.name,
            arguments: "",
            status: "in_progress",
          },
        }),
      );
    }

    if (delta.function?.name && !tool.nameDone) {
      const decoded = this.toolNames.decode(delta.function.name);
      tool.name = decoded.name;
      tool.namespace = decoded.namespace;
      tool.nameDone = true;
      events.push(
        this.emit("response.function_call_name.done", {
          item_id: id,
          output_index: tool.outputIndex,
          name: tool.name,
        }),
      );
    }

    const argumentDelta = delta.function?.arguments ?? "";
    const append = computeAppendDelta(tool.arguments, argumentDelta);
    if (append) {
      tool.arguments += append;
      for (const part of splitArgumentDelta(append)) {
        events.push(
          this.emit("response.function_call_arguments.delta", {
            item_id: id,
            output_index: tool.outputIndex,
            delta: part,
          }),
        );
      }
    }
    return events;
  }

  private emit(type: string, payload: Record<string, unknown>): Uint8Array {
    this.sequence += 1;
    return this.encoder.encode(
      sse({ type, sequence_number: this.sequence, ...payload }),
    );
  }
}

export async function* parseChatCompletionSse(
  body: ReadableStream<Uint8Array>,
  options: {
    requestId?: string;
    logger?: DebugLogger;
    idleTimeoutMs?: number;
    signal?: AbortSignal;
  } = {},
): AsyncGenerator<ChatCompletionChunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let rawChunkCount = 0;
  let eventCount = 0;
  const idleTimeoutMs = options.idleTimeoutMs ?? 0;
  const logger = options.logger;
  const requestId = options.requestId;
  const signal = options.signal;
  try {
    while (true) {
      const { done, value } = await readWithOptionalTimeout(
        reader as StreamReader,
        idleTimeoutMs,
        requestId,
        signal,
      );
      if (done) {
        logger?.log("upstream.sse.eof", {
          request_id: requestId,
          raw_chunks: rawChunkCount,
          events: eventCount,
        });
        break;
      }
      rawChunkCount += 1;
      logger?.log(
        "upstream.sse.raw_chunk",
        {
          request_id: requestId,
          raw_chunks: rawChunkCount,
          bytes: value.byteLength,
        },
        "trace",
      );
      // Normalize CRLF to LF so events framed with `\r\n\r\n` (allowed by the SSE
      // spec, emitted by some proxies / non-Z.AI OpenAI-compatible servers) split
      // correctly — `indexOf("\n\n")` alone never matches a `\r\n\r\n` boundary.
      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const rawEvent = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        for (const line of rawEvent.split(/\r?\n/)) {
          if (!line.startsWith("data:")) {
            continue;
          }
          const data = line.slice(5).trimStart();
          if (!data || data === "[DONE]") {
            if (data === "[DONE]") {
              logger?.log("upstream.sse.done_marker", {
                request_id: requestId,
                raw_chunks: rawChunkCount,
                events: eventCount,
              });
            }
            continue;
          }
          eventCount += 1;
          yield JSON.parse(data) as ChatCompletionChunk;
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
  } finally {
    reader.releaseLock();
  }
}

async function readWithOptionalTimeout(
  reader: StreamReader,
  idleTimeoutMs: number,
  requestId?: string,
  signal?: AbortSignal,
): Promise<StreamReadResult> {
  if (signal?.aborted) {
    await reader.cancel(signal.reason ?? "zodex stream cancelled").catch(() => undefined);
    return { done: true };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let removeAbortListener: (() => void) | undefined;
  const timeout = Symbol("timeout");
  const aborted = Symbol("aborted");
  try {
    const contenders: Promise<StreamReadResult | typeof timeout | typeof aborted>[] = [
      reader.read(),
    ];
    if (idleTimeoutMs > 0) {
      contenders.push(new Promise<typeof timeout>((resolve) => {
        timer = setTimeout(() => {
          resolve(timeout);
        }, idleTimeoutMs);
      }));
    }
    if (signal) {
      contenders.push(new Promise<typeof aborted>((resolve) => {
        const onAbort = () => resolve(aborted);
        signal.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = () => signal.removeEventListener("abort", onAbort);
      }));
    }
    const result = await Promise.race(contenders);
    if (result === timeout) {
      await reader.cancel("zodex upstream SSE idle timeout").catch(() => undefined);
      throw new Error(
        `upstream SSE idle timeout after ${idleTimeoutMs}ms${
          requestId ? ` for ${requestId}` : ""
        }`,
      );
    }
    if (result === aborted) {
      await reader.cancel(signal?.reason ?? "zodex stream cancelled").catch(() => undefined);
      return { done: true };
    }
    return result;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    removeAbortListener?.();
  }
}
