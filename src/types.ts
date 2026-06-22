import type { DebugConfig } from "./debug";

export interface ResponsesRequest {
  model?: string;
  input?: unknown;
  instructions?: unknown;
  stream?: boolean;
  max_output_tokens?: number;
  temperature?: number;
  top_p?: number;
  tools?: unknown[];
  tool_choice?: unknown;
  parallel_tool_calls?: boolean;
  metadata?: unknown;
  user?: string;
  text?: unknown;
  reasoning?: unknown;
  store?: boolean;
  previous_response_id?: string | null;
  truncation?: unknown;
  [key: string]: unknown;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: unknown;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ChatToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
  index?: number;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  tools?: unknown[];
  tool_choice?: unknown;
  parallel_tool_calls?: boolean;
  user?: string;
  metadata?: unknown;
  reasoning_effort?: unknown;
  stream_options?: { include_usage: boolean };
}

export interface ChatCompletionChunk {
  id?: string;
  model?: string;
  choices?: Array<{
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      reasoning?: string | null;
      tool_calls?: ChatToolCallDelta[];
    };
    finish_reason?: string | null;
  }>;
  usage?: unknown;
  [key: string]: unknown;
}

export interface ChatToolCallDelta {
  id?: string;
  index?: number;
  type?: "function";
  function?: {
    name?: string;
    arguments?: string;
  };
}

export interface ChatCompletionResponse {
  id?: string;
  model?: string;
  choices?: Array<{
    message?: {
      content?: string | null;
      reasoning_content?: string | null;
      reasoning?: string | null;
      tool_calls?: ChatToolCall[];
    };
    finish_reason?: string | null;
  }>;
  usage?: unknown;
  [key: string]: unknown;
}

export interface RuntimeConfig {
  host: string;
  port: number;
  upstreamBaseUrl: string;
  apiKey?: string;
  defaultModel: string;
  debug: DebugConfig;
  upstreamFetchTimeoutMs: number;
  streamIdleTimeoutMs: number;
}
