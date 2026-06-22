import { DEFAULT_MODEL } from "./constants";
import { toolCallId } from "./ids";
import type {
  ChatCompletionRequest,
  ChatMessage,
  ChatToolCall,
  ResponsesRequest,
} from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrJson(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === undefined || value === null) {
    return "";
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function contentToText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      if (typeof part === "string") {
        parts.push(part);
        continue;
      }
      if (!isRecord(part)) {
        continue;
      }
      const type = String(part.type ?? "");
      if (
        type === "text" ||
        type === "input_text" ||
        type === "output_text" ||
        type === "summary_text"
      ) {
        parts.push(stringOrJson(part.text));
      }
    }
    return parts.join("");
  }
  return stringOrJson(content);
}

function appendMessage(messages: ChatMessage[], message: ChatMessage): void {
  const last = messages.at(-1);
  if (
    last?.role === "assistant" &&
    message.role === "assistant" &&
    last.tool_calls &&
    message.tool_calls &&
    (!last.content || last.content === "") &&
    (!message.content || message.content === "")
  ) {
    last.tool_calls.push(...message.tool_calls);
    return;
  }
  messages.push(message);
}

function functionCallFromItem(item: Record<string, unknown>): ChatToolCall {
  const id = stringOrJson(item.call_id ?? item.id ?? toolCallId());
  return {
    id,
    type: "function",
    function: {
      name: stringOrJson(item.name ?? "tool"),
      arguments: stringOrJson(item.arguments ?? "{}"),
    },
  };
}

function itemToMessages(item: Record<string, unknown>): ChatMessage[] {
  const type = String(item.type ?? "");

  if (type === "function_call") {
    return [
      {
        role: "assistant",
        content: null,
        tool_calls: [functionCallFromItem(item)],
      },
    ];
  }

  if (type === "function_call_output" || type === "custom_tool_call_output") {
    const callId = item.call_id ?? item.id;
    if (!callId) {
      return [];
    }
    return [
      {
        role: "tool",
        tool_call_id: stringOrJson(callId),
        content: contentToText(item.output),
      },
    ];
  }

  if (
    type === "local_shell_call" ||
    type === "custom_tool_call" ||
    type === "tool_search_call"
  ) {
    return [
      {
        role: "assistant",
        content: `[${type}]\n${stringOrJson(item)}`,
      },
    ];
  }

  if (type === "reasoning") {
    const summary = Array.isArray(item.summary)
      ? item.summary.map(contentToText).join("")
      : contentToText(item.summary ?? item.content);
    if (!summary) {
      return [];
    }
    return [{ role: "assistant", content: `[reasoning]\n${summary}` }];
  }

  const role = String(item.role ?? "user");
  const chatRole =
    role === "assistant" || role === "system" || role === "tool"
      ? role
      : "user";
  const content = item.content === undefined ? item.text : item.content;
  if (content === undefined || content === null) {
    return [];
  }
  return [{ role: chatRole, content: contentToText(content) }];
}

function normalizeTools(tools: unknown[] | undefined): unknown[] | undefined {
  if (!tools?.length) {
    return undefined;
  }

  const normalized = tools.flatMap((tool) => {
    if (!isRecord(tool)) {
      return [];
    }
    if (tool.type !== "function") {
      return [];
    }
    if (isRecord(tool.function)) {
      return [tool];
    }
    const parameters: Record<string, unknown> = isRecord(tool.parameters)
      ? { ...tool.parameters }
      : { type: "object" };
    if (!("type" in parameters)) {
      parameters.type = "object";
    }
    return [{
      type: "function",
      function: {
        name: stringOrJson(tool.name ?? ""),
        description: stringOrJson(tool.description ?? ""),
        parameters,
        strict: Boolean(tool.strict ?? false),
      },
    }];
  });
  return normalized.length ? normalized : undefined;
}

export function normalizeToolChoice(toolChoice: unknown): unknown {
  if (toolChoice === undefined || toolChoice === null) {
    return undefined;
  }
  if (typeof toolChoice === "string") {
    return toolChoice;
  }
  if (!isRecord(toolChoice)) {
    return toolChoice;
  }
  if (isRecord(toolChoice.function) && toolChoice.function.name) {
    return toolChoice;
  }
  const type = String(toolChoice.type ?? "");
  if (type === "auto" || type === "none") {
    return type;
  }
  if (type === "required" || type === "tool" || type === "any") {
    return "required";
  }
  if (type === "function" && toolChoice.name) {
    return {
      type: "function",
      function: { name: stringOrJson(toolChoice.name) },
    };
  }
  return toolChoice;
}

function firstToolName(tools: unknown[] | undefined): string {
  const first = tools?.find((tool) => isRecord(tool) && tool.type === "function");
  if (isRecord(first) && isRecord(first.function) && first.function.name) {
    return stringOrJson(first.function.name);
  }
  return "tool";
}

function ensureToolOutputsHaveCalls(
  messages: ChatMessage[],
  tools: unknown[] | undefined,
): ChatMessage[] {
  const result: ChatMessage[] = [];
  for (const message of messages) {
    if (message.role !== "tool" || !message.tool_call_id) {
      result.push(message);
      continue;
    }

    const previousAssistant = [...result]
      .reverse()
      .find((entry) => entry.role === "assistant");
    const hasCall = previousAssistant?.tool_calls?.some(
      (call) => call.id === message.tool_call_id,
    );
    if (!hasCall) {
      result.push({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: message.tool_call_id,
            type: "function",
            function: { name: firstToolName(tools), arguments: "{}" },
          },
        ],
      });
    }
    result.push(message);
  }
  return result;
}

export function translateResponsesRequest(
  request: ResponsesRequest,
  defaultModel = DEFAULT_MODEL,
): ChatCompletionRequest {
  const model = String(request.model || defaultModel).toLowerCase();
  const systemParts: string[] = [];
  const messages: ChatMessage[] = [];

  if (request.instructions !== undefined && request.instructions !== null) {
    systemParts.push(contentToText(request.instructions));
  }

  const input = request.input ?? "";
  if (typeof input === "string") {
    appendMessage(messages, { role: "user", content: input });
  } else if (Array.isArray(input)) {
    for (const rawItem of input) {
      if (!isRecord(rawItem)) {
        appendMessage(messages, { role: "user", content: contentToText(rawItem) });
        continue;
      }
      const role = String(rawItem.role ?? "");
      if (role === "system" || role === "developer") {
        systemParts.push(contentToText(rawItem.content ?? rawItem.text));
        continue;
      }
      for (const message of itemToMessages(rawItem)) {
        appendMessage(messages, message);
      }
    }
  } else if (isRecord(input)) {
    for (const message of itemToMessages(input)) {
      appendMessage(messages, message);
    }
  }

  const tools = normalizeTools(request.tools);
  const fixedMessages = ensureToolOutputsHaveCalls(messages, tools);

  if (systemParts.length > 0) {
    fixedMessages.unshift({
      role: "system",
      content: systemParts.filter(Boolean).join("\n\n"),
    });
  }

  const translated: ChatCompletionRequest = {
    model,
    messages: fixedMessages.length
      ? fixedMessages
      : [{ role: "user", content: "" }],
    stream: request.stream,
  };

  if (typeof request.max_output_tokens === "number") {
    translated.max_tokens = request.max_output_tokens;
  }
  if (typeof request.temperature === "number") {
    translated.temperature = request.temperature;
  }
  if (typeof request.top_p === "number") {
    translated.top_p = request.top_p;
  }
  if (typeof request.parallel_tool_calls === "boolean") {
    translated.parallel_tool_calls = request.parallel_tool_calls;
  }
  if (request.user) {
    translated.user = request.user;
  }
  if (request.metadata !== undefined) {
    translated.metadata = request.metadata;
  }
  const normalizedToolChoice = normalizeToolChoice(request.tool_choice);
  if (normalizedToolChoice !== undefined) {
    translated.tool_choice = normalizedToolChoice;
  }
  if (tools) {
    translated.tools = tools;
  }
  if (
    typeof request.reasoning === "object" &&
    request.reasoning !== null &&
    !Array.isArray(request.reasoning)
  ) {
    const reasoning = request.reasoning as Record<string, unknown>;
    if (typeof reasoning.effort === "string") {
      translated.reasoning_effort = reasoning.effort;
    }
  }
  if (request.stream) {
    translated.stream_options = { include_usage: true };
  }

  return translated;
}
