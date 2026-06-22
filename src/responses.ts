import { DEFAULT_MODEL } from "./constants";
import { messageId, reasoningId, responseId } from "./ids";
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
    output.push({
      id: reasoningId(),
      type: "reasoning",
      summary: [{ type: "summary_text", text: String(reasoning) }],
    });
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

  for (const call of message?.tool_calls ?? []) {
    output.push({
      type: "function_call",
      id: call.id,
      call_id: call.id,
      name: call.function.name,
      arguments: call.function.arguments,
      status: "completed",
    });
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
      code: status,
      message,
    },
  });
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
  arguments: string;
  outputIndex: number;
  nameDone: boolean;
  done: boolean;
}

export class ResponsesStreamTranslator {
  private sequence = 0;
  private readonly id = responseId();
  private readonly encoder = new TextEncoder();
  private readonly output: unknown[] = [];
  private readonly toolsById = new Map<string, ToolState>();
  private readonly toolIdByIndex = new Map<number, string>();
  private nextOutputIndex = 0;
  private text = "";
  private textItemId = "";
  private textOutputIndex = -1;
  private textStarted = false;
  private reasoning = "";
  private reasoningItemId = "";
  private reasoningOutputIndex = -1;
  private reasoningStarted = false;
  private reasoningDone = false;
  private usage: unknown = null;
  private failure: { status: number; message: string } | null = null;

  constructor(private readonly request: ResponsesRequest) {}

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
    if (this.failure) {
      return this.fail(this.failure.status, this.failure.message);
    }
    const events: Uint8Array[] = [];
    if (this.reasoningStarted && !this.reasoningDone) {
      events.push(
        this.emit("response.reasoning_text.done", {
          item_id: this.reasoningItemId,
          output_index: this.reasoningOutputIndex,
          text: this.reasoning,
        }),
      );
      const item = {
        id: this.reasoningItemId,
        type: "reasoning",
        summary: [{ type: "summary_text", text: this.reasoning }],
      };
      this.output[this.reasoningOutputIndex] = item;
      events.push(
        this.emit("response.output_item.done", {
          output_index: this.reasoningOutputIndex,
          item,
        }),
      );
      this.reasoningDone = true;
    }

    if (this.textStarted) {
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
        status: "completed",
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
    }

    for (const tool of this.toolsById.values()) {
      if (tool.done) {
        continue;
      }
      tool.arguments = repairJsonArguments(tool.arguments);
      events.push(
        this.emit("response.function_call_arguments.done", {
          item_id: tool.id,
          output_index: tool.outputIndex,
          arguments: tool.arguments,
        }),
      );
      const item = {
        type: "function_call",
        id: tool.id,
        call_id: tool.id,
        name: tool.name,
        arguments: tool.arguments,
        status: "completed",
      };
      this.output[tool.outputIndex] = item;
      events.push(
        this.emit("response.output_item.done", {
          output_index: tool.outputIndex,
          item,
        }),
      );
      tool.done = true;
    }

    events.push(
      this.emit("response.completed", {
        response: responseObject({
          request: this.request,
          id: this.id,
          status: "completed",
          output: this.output.filter(Boolean),
          usage: this.usage,
        }),
      }),
    );
    events.push(this.encoder.encode("data: [DONE]\n\n"));
    return events;
  }

  fail(status: number, message: string): Uint8Array[] {
    return [
      this.emit("response.failed", {
        response: errorResponse(this.request, status, message),
      }),
      this.encoder.encode("data: [DONE]\n\n"),
    ];
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
            summary: [],
          },
        }),
      );
    }
    this.reasoning += delta;
    events.push(
      this.emit("response.reasoning_text.delta", {
        item_id: this.reasoningItemId,
        output_index: this.reasoningOutputIndex,
        delta,
      }),
    );
    return events;
  }

  private toolDelta(delta: ChatToolCallDelta): Uint8Array[] {
    const events: Uint8Array[] = [];
    const index = delta.index ?? 0;
    const id = delta.id ?? this.toolIdByIndex.get(index) ?? `call_${index}`;
    this.toolIdByIndex.set(index, id);

    let tool = this.toolsById.get(id);
    if (!tool) {
      tool = {
        id,
        name: delta.function?.name ?? "",
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
            name: tool.name,
            arguments: "",
            status: "in_progress",
          },
        }),
      );
    }

    if (delta.function?.name && !tool.nameDone) {
      tool.name = delta.function.name;
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
): AsyncGenerator<ChatCompletionChunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
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
            continue;
          }
          yield JSON.parse(data) as ChatCompletionChunk;
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
  } finally {
    reader.releaseLock();
  }
}
