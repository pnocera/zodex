import { describe, expect, test } from "bun:test";
import {
  chatCompletionToResponse,
  errorResponse,
  parseChatCompletionSse,
  ResponsesStreamTranslator,
} from "../src/responses";

function decodeEvents(chunks: Uint8Array[]): any[] {
  const text = new TextDecoder().decode(
    new Uint8Array(chunks.flatMap((chunk) => [...chunk])),
  );
  return text
    .split("\n\n")
    .filter((event) => event.startsWith("data: {"))
    .map((event) => JSON.parse(event.slice("data: ".length)));
}

describe("ResponsesStreamTranslator", () => {
  test("streams text events and completed output", () => {
    const translator = new ResponsesStreamTranslator({
      model: "glm-5.2",
      input: "Say OK",
      stream: true,
    });

    const events = decodeEvents([
      ...translator.start(),
      ...translator.applyChunk({ choices: [{ delta: { content: "O" } }] }),
      ...translator.applyChunk({ choices: [{ delta: { content: "K" } }] }),
      ...translator.finish(),
    ]);

    expect(events.map((event) => event.type)).toContain(
      "response.output_text.delta",
    );
    const completed = events.find((event) => event.type === "response.completed");
    expect(completed.response.output[0].content[0].text).toBe("OK");
  });

  test("does not drop repeated incremental text deltas", () => {
    const translator = new ResponsesStreamTranslator({
      model: "glm-5.2",
      input: "laugh",
      stream: true,
    });

    const events = decodeEvents([
      ...translator.start(),
      ...translator.applyChunk({ choices: [{ delta: { content: "ha" } }] }),
      ...translator.applyChunk({ choices: [{ delta: { content: "ha" } }] }),
      ...translator.applyChunk({ choices: [{ delta: { content: "ha" } }] }),
      ...translator.finish(),
    ]);

    const completed = events.find((event) => event.type === "response.completed");
    expect(completed.response.output[0].content[0].text).toBe("hahaha");
  });

  test("streams tool call argument delta and final item", () => {
    const translator = new ResponsesStreamTranslator({
      model: "glm-5.2",
      input: "weather",
      stream: true,
    });

    const events = decodeEvents([
      ...translator.start(),
      ...translator.applyChunk({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  id: "call_1",
                  index: 0,
                  type: "function",
                  function: {
                    name: "get_weather",
                    arguments: "{\"city\":\"Paris\"}",
                  },
                },
              ],
            },
          },
        ],
      }),
      ...translator.finish(),
    ]);

    expect(events.map((event) => event.type)).toContain(
      "response.function_call_arguments.delta",
    );
    const completed = events.find((event) => event.type === "response.completed");
    expect(completed.response.output[0]).toMatchObject({
      type: "function_call",
      id: "call_1",
      name: "get_weather",
      arguments: "{\"city\":\"Paris\"}",
    });
  });

  test("does not drop repeated incremental tool argument deltas", () => {
    const translator = new ResponsesStreamTranslator({
      model: "glm-5.2",
      input: "tool",
      stream: true,
    });

    const events = decodeEvents([
      ...translator.start(),
      ...translator.applyChunk({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  id: "call_1",
                  index: 0,
                  type: "function",
                  function: { name: "echo", arguments: "{\"x\":\"ha" },
                },
              ],
            },
          },
        ],
      }),
      ...translator.applyChunk({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  type: "function",
                  function: { arguments: "ha\"}" },
                },
              ],
            },
          },
        ],
      }),
      ...translator.finish(),
    ]);

    const completed = events.find((event) => event.type === "response.completed");
    expect(completed.response.output[0].arguments).toBe("{\"x\":\"haha\"}");
  });

  test("decodes flattened namespace tool names in streaming output", () => {
    const translator = new ResponsesStreamTranslator({
      model: "glm-5.2",
      input: "tool",
      stream: true,
      tools: [
        {
          type: "namespace",
          name: "mcp.fs",
          tools: [{ type: "function", name: "read/file" }],
        },
      ],
    });

    const events = decodeEvents([
      ...translator.start(),
      ...translator.applyChunk({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  id: "call_1",
                  index: 0,
                  type: "function",
                  function: {
                    name: "mcp_fs_read_file",
                    arguments: "{\"path\":\"README.md\"}",
                  },
                },
              ],
            },
          },
        ],
      }),
      ...translator.finish(),
    ]);

    const completed = events.find((event) => event.type === "response.completed");
    expect(completed.response.output[0]).toMatchObject({
      type: "function_call",
      id: "call_1",
      namespace: "mcp.fs",
      name: "read/file",
      arguments: "{\"path\":\"README.md\"}",
    });
  });

  test("migrates a synthetic streaming tool id when the real id arrives later", () => {
    const translator = new ResponsesStreamTranslator({
      model: "glm-5.2",
      input: "tool",
      stream: true,
    });

    const events = decodeEvents([
      ...translator.start(),
      ...translator.applyChunk({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  type: "function",
                  function: { name: "echo", arguments: "{" },
                },
              ],
            },
          },
        ],
      }),
      ...translator.applyChunk({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  id: "call_real",
                  index: 0,
                  type: "function",
                  function: { arguments: "}" },
                },
              ],
            },
          },
        ],
      }),
      ...translator.finish(),
    ]);

    const completed = events.find((event) => event.type === "response.completed");
    expect(completed.response.output).toHaveLength(1);
    expect(completed.response.output[0]).toMatchObject({
      type: "function_call",
      id: "call_real",
      name: "echo",
      arguments: "{}",
    });
  });

  test("emits Codex-compatible reasoning summary items", () => {
    const translator = new ResponsesStreamTranslator({
      model: "glm-5.2",
      input: "think",
      stream: true,
    });

    const events = decodeEvents([
      ...translator.start(),
      ...translator.applyChunk({
        choices: [{ delta: { reasoning_content: "because" } }],
      }),
      ...translator.finish(),
    ]);

    expect(events.map((event) => event.type)).toContain(
      "response.reasoning_summary_text.delta",
    );
    const completed = events.find((event) => event.type === "response.completed");
    expect(completed.response.output[0]).toMatchObject({
      type: "reasoning",
      encrypted_content: null,
      summary: [{ type: "summary_text", text: "because" }],
    });
  });
});

describe("chatCompletionToResponse", () => {
  test("converts non-streaming chat completion output", () => {
    const response = chatCompletionToResponse(
      {
        id: "chatcmpl_1",
        model: "glm-5.2",
        choices: [{ message: { content: "OK" } }],
      },
      { model: "glm-5.2", input: "Say OK" },
    );

    expect(response.id).toBe("chatcmpl_1");
    expect((response.output as any[])[0].content[0].text).toBe("OK");
  });

  test("normalizes chat completion usage to Responses usage", () => {
    const response = chatCompletionToResponse(
      {
        id: "chatcmpl_1",
        model: "glm-5.2",
        choices: [{ message: { content: "OK" } }],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 3,
          total_tokens: 13,
          completion_tokens_details: { reasoning_tokens: 2 },
        },
      },
      { model: "glm-5.2", input: "Say OK" },
    );

    expect(response.usage).toEqual({
      input_tokens: 10,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 3,
      output_tokens_details: { reasoning_tokens: 2 },
      total_tokens: 13,
    });
  });

  test("decodes flattened namespace tool names in non-streaming output", () => {
    const response = chatCompletionToResponse(
      {
        id: "chatcmpl_1",
        model: "glm-5.2",
        choices: [
          {
            message: {
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: {
                    name: "mcp_fs_read_file",
                    arguments: "{\"path\":\"README.md\"}",
                  },
                },
              ],
            },
          },
        ],
      },
      {
        model: "glm-5.2",
        input: "tool",
        tools: [
          {
            type: "namespace",
            name: "mcp.fs",
            tools: [{ type: "function", name: "read/file" }],
          },
        ],
      },
    );

    expect((response.output as any[])[0]).toMatchObject({
      type: "function_call",
      namespace: "mcp.fs",
      name: "read/file",
    });
  });

  test("non-streaming reasoning item includes encrypted_content", () => {
    const response = chatCompletionToResponse(
      {
        id: "chatcmpl_1",
        model: "glm-5.2",
        choices: [{ message: { reasoning_content: "because" } }],
      },
      { model: "glm-5.2", input: "think" },
    );

    expect((response.output as any[])[0]).toMatchObject({
      type: "reasoning",
      encrypted_content: null,
      summary: [{ type: "summary_text", text: "because" }],
    });
  });
});

describe("errorResponse", () => {
  test("emits Codex-compatible string error codes", () => {
    const response = errorResponse({ input: "hi" }, 502, "bad gateway");
    const invalid = errorResponse({ input: "hi" }, 400, "bad request");
    const limited = errorResponse({ input: "hi" }, 429, "rate limited");
    const overloaded = errorResponse({ input: "hi" }, 503, "overloaded");

    expect((response.error as any).code).toBe("502");
    expect((response.error as any).message).toBe("bad gateway");
    expect((invalid.error as any).code).toBe("invalid_prompt");
    expect((limited.error as any).code).toBe("rate_limit_exceeded");
    expect((overloaded.error as any).code).toBe("server_is_overloaded");
  });
});

describe("parseChatCompletionSse", () => {
  test("cancels upstream reader when abort signal fires", async () => {
    let upstreamCancelled = false;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode('data: {"choices":[{"delta":{"content":"O"}}]}\n\n'),
        );
      },
      cancel() {
        upstreamCancelled = true;
      },
    });
    const abort = new AbortController();
    const iterator = parseChatCompletionSse(stream, { signal: abort.signal });

    const first = await iterator.next();
    expect(first.done).toBe(false);
    expect(first.value?.choices[0]?.delta?.content).toBe("O");

    abort.abort("client disconnected");
    const second = await iterator.next();

    expect(second.done).toBe(true);
    expect(upstreamCancelled).toBe(true);
  });

  test("throws a useful error when upstream stream goes idle", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start() {
        // Intentionally never enqueue or close.
      },
    });
    const iterator = parseChatCompletionSse(stream, {
      requestId: "req_test",
      idleTimeoutMs: 5,
    });

    let message = "";
    try {
      await iterator.next();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain("upstream SSE idle timeout after 5ms for req_test");
  });
});
