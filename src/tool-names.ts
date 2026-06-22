export interface DecodedToolName {
  name: string;
  namespace?: string;
}

export interface DroppedTool {
  type: string;
  name?: string;
  reason: string;
}

export interface ToolNameCodec {
  encode(tool: DecodedToolName): string;
  decode(chatName: string): DecodedToolName;
  dropped: DroppedTool[];
}

const MAX_TOOL_NAME_LENGTH = 64;

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

function toolKey(tool: DecodedToolName): string {
  return `${tool.namespace ?? ""}\u0000${tool.name}`;
}

function sanitizeToolName(name: string): string {
  const cleaned = name
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return (cleaned || "tool").slice(0, MAX_TOOL_NAME_LENGTH);
}

function uniqueToolName(rawName: string, used: Set<string>): string {
  const base = sanitizeToolName(rawName);
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let suffix = 2;
  while (true) {
    const marker = `_${suffix}`;
    const candidate = `${base.slice(0, MAX_TOOL_NAME_LENGTH - marker.length)}${marker}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
    suffix += 1;
  }
}

function collectFunctionTool(
  tool: Record<string, unknown>,
  namespace: string | undefined,
  used: Set<string>,
  responseToChat: Map<string, string>,
  chatToResponse: Map<string, DecodedToolName>,
  chatNamesByBareName: Map<string, Set<string>>,
): void {
  const name = stringOrJson(tool.name ?? "");
  if (!name) {
    return;
  }
  const rawChatName = namespace ? `${namespace}__${name}` : name;
  const chatName = uniqueToolName(rawChatName, used);
  const decoded = namespace ? { namespace, name } : { name };
  responseToChat.set(toolKey(decoded), chatName);
  chatToResponse.set(chatName, decoded);
  if (namespace) {
    const chatNames = chatNamesByBareName.get(name) ?? new Set<string>();
    chatNames.add(chatName);
    chatNamesByBareName.set(name, chatNames);
  }
}

export function buildToolNameCodec(tools: unknown[] | undefined): ToolNameCodec {
  const used = new Set<string>();
  const responseToChat = new Map<string, string>();
  const chatToResponse = new Map<string, DecodedToolName>();
  const chatNamesByBareName = new Map<string, Set<string>>();
  const dropped: DroppedTool[] = [];

  for (const tool of tools ?? []) {
    if (!isRecord(tool)) {
      dropped.push({ type: "unknown", reason: "tool is not an object" });
      continue;
    }
    const type = stringOrJson(tool.type ?? "unknown");
    if (type === "function") {
      collectFunctionTool(
        tool,
        undefined,
        used,
        responseToChat,
        chatToResponse,
        chatNamesByBareName,
      );
      continue;
    }
    if (type === "namespace") {
      const namespace = stringOrJson(tool.name ?? "");
      const innerTools = Array.isArray(tool.tools) ? tool.tools : [];
      for (const innerTool of innerTools) {
        if (!isRecord(innerTool) || innerTool.type !== "function") {
          continue;
        }
        collectFunctionTool(
          innerTool,
          namespace,
          used,
          responseToChat,
          chatToResponse,
          chatNamesByBareName,
        );
      }
      continue;
    }
    dropped.push({
      type,
      name: typeof tool.name === "string" ? tool.name : undefined,
      reason: "unsupported Responses tool type for Chat Completions",
    });
  }

  return {
    dropped,
    encode(tool) {
      const exact = responseToChat.get(toolKey(tool));
      if (exact) {
        return exact;
      }
      if (!tool.namespace) {
        const uniqueNamespacedMatch = chatNamesByBareName.get(tool.name);
        if (uniqueNamespacedMatch?.size === 1) {
          return [...uniqueNamespacedMatch][0] ?? sanitizeToolName(tool.name);
        }
      }
      return sanitizeToolName(tool.name);
    },
    decode(chatName) {
      return chatToResponse.get(chatName) ?? { name: chatName };
    },
  };
}
