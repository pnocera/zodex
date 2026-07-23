import { DEFAULT_MODEL } from "./constants";
import type { DebugLogger } from "./debug";
import { toolCallId } from "./ids";
import { buildToolNameCodec, type ToolNameCodec } from "./tool-names";
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

export function zaiReasoningEffort(effort: string): string {
  switch (effort.trim().toLowerCase()) {
    case "xhigh":
    case "max":
    case "ultracode":
      return "max";
    default:
      return "high";
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
  // Chat Completions expects a single assistant turn to carry both its text and
  // its tool_calls. Coalesce an incoming function_call (assistant message with
  // tool_calls and no content) onto the preceding assistant message — whether
  // that message is prior tool_calls (parallel calls) or an assistant text
  // message — instead of emitting two adjacent assistant messages.
  if (
    last?.role === "assistant" &&
    message.role === "assistant" &&
    message.tool_calls &&
    (!message.content || message.content === "")
  ) {
    last.tool_calls = last.tool_calls
      ? [...last.tool_calls, ...message.tool_calls]
      : [...message.tool_calls];
    return;
  }
  messages.push(message);
}

function functionCallFromItem(
  item: Record<string, unknown>,
  toolNames: ToolNameCodec,
): ChatToolCall {
  const id = stringOrJson(item.call_id ?? item.id ?? toolCallId());
  const name = stringOrJson(item.name ?? "tool");
  const namespace =
    typeof item.namespace === "string" ? item.namespace : undefined;
  return {
    id,
    type: "function",
    function: {
      name: toolNames.encode({ namespace, name }),
      arguments: stringOrJson(item.arguments ?? "{}"),
    },
  };
}

function itemToMessages(
  item: Record<string, unknown>,
  toolNames: ToolNameCodec,
): ChatMessage[] {
  const type = String(item.type ?? "");

  if (type === "function_call") {
    return [
      {
        role: "assistant",
        content: null,
        tool_calls: [functionCallFromItem(item, toolNames)],
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
    return [];
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

function descriptionWithNamespace(
  description: unknown,
  namespace: string,
): string {
  const text = stringOrJson(description);
  return text ? `[namespace: ${namespace}] ${text}` : `[namespace: ${namespace}]`;
}

function normalizeFunctionTool(
  tool: Record<string, unknown>,
  name: string,
  description = tool.description,
): unknown {
  const parameters: Record<string, unknown> = isRecord(tool.parameters)
    ? { ...tool.parameters }
    : { type: "object" };
  if (!("type" in parameters)) {
    parameters.type = "object";
  }
  return {
    type: "function",
    function: {
      name,
      description: stringOrJson(description),
      parameters,
      strict: Boolean(tool.strict ?? false),
    },
  };
}

function normalizeTools(
  tools: unknown[] | undefined,
  toolNames: ToolNameCodec,
): unknown[] | undefined {
  if (!tools?.length) {
    return undefined;
  }

  const normalized = tools.flatMap((tool) => {
    if (!isRecord(tool)) {
      return [];
    }
    if (tool.type === "namespace") {
      const namespace = stringOrJson(tool.name ?? "");
      const innerTools = Array.isArray(tool.tools) ? tool.tools : [];
      return innerTools.flatMap((innerTool) => {
        if (!isRecord(innerTool) || innerTool.type !== "function") {
          return [];
        }
        const name = stringOrJson(innerTool.name ?? "");
        if (!name) {
          return [];
        }
        return [
          normalizeFunctionTool(
            innerTool,
            toolNames.encode({ namespace, name }),
            descriptionWithNamespace(innerTool.description, namespace),
          ),
        ];
      });
    }
    if (tool.type !== "function") {
      return [];
    }
    if (isRecord(tool.function)) {
      return [tool];
    }
    const name = stringOrJson(tool.name ?? "");
    return [normalizeFunctionTool(tool, toolNames.encode({ name }))];
  });
  return normalized.length ? normalized : undefined;
}

export function normalizeToolChoice(
  toolChoice: unknown,
  toolNames = buildToolNameCodec(undefined),
): unknown {
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
    return {
      ...toolChoice,
      function: {
        ...toolChoice.function,
        name: toolNames.encode({
          name: stringOrJson(toolChoice.function.name),
          namespace:
            typeof toolChoice.function.namespace === "string"
              ? toolChoice.function.namespace
              : undefined,
        }),
      },
    };
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
      function: {
        name: toolNames.encode({
          name: stringOrJson(toolChoice.name),
          namespace:
            typeof toolChoice.namespace === "string"
              ? toolChoice.namespace
              : undefined,
        }),
      },
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
  // Track the most recent assistant message as we build `result` so each tool
  // output can check its matching call in O(1) instead of rescanning the whole
  // prefix (previously O(n²) over a long session's tool round-trips).
  let lastAssistant: ChatMessage | undefined;
  for (const message of messages) {
    if (message.role !== "tool" || !message.tool_call_id) {
      result.push(message);
      if (message.role === "assistant") {
        lastAssistant = message;
      }
      continue;
    }

    const hasCall = lastAssistant?.tool_calls?.some(
      (call) => call.id === message.tool_call_id,
    );
    if (!hasCall) {
      // Repair malformed Codex history (a tool output with no preceding call).
      // firstToolName picks a *declared* function tool so the synthesized call's
      // name still matches the request's tool set — upstreams that validate
      // tool_call names against declared tools reject an invented name.
      const synthetic: ChatMessage = {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: message.tool_call_id,
            type: "function",
            function: { name: firstToolName(tools), arguments: "{}" },
          },
        ],
      };
      result.push(synthetic);
      lastAssistant = synthetic;
    }
    result.push(message);
  }
  return result;
}

export function translateResponsesRequest(
  request: ResponsesRequest,
  defaultModel = DEFAULT_MODEL,
  logger?: DebugLogger,
): ChatCompletionRequest {
  const requestedModel = String(request.model || defaultModel);
  // Model ids are lowercased before forwarding (Z.AI expects lowercase). Some
  // OpenAI-compatible upstreams are case-sensitive, so log when this actually
  // changes the id — a resulting 404 is then diagnosable from the debug log.
  const model = requestedModel.toLowerCase();
  if (logger && model !== requestedModel) {
    logger.log(
      "request.model.lowercased",
      { requested: requestedModel, forwarded: model },
      "trace",
    );
  }
  const toolNames = buildToolNameCodec(request.tools);
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
      for (const message of itemToMessages(rawItem, toolNames)) {
        appendMessage(messages, message);
      }
    }
  } else if (isRecord(input)) {
    for (const message of itemToMessages(input, toolNames)) {
      appendMessage(messages, message);
    }
  }

  const tools = normalizeTools(request.tools, toolNames);
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
  const normalizedToolChoice = normalizeToolChoice(request.tool_choice, toolNames);
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
      translated.reasoning_effort = zaiReasoningEffort(reasoning.effort);
    }
  }
  if (request.stream) {
    translated.stream_options = { include_usage: true };
  }

  return translated;
}
