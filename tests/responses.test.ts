import { describe, expect, test } from "bun:test";
import {
  chatCompletionToResponse,
  errorResponse,
  parseChatCompletionSse,
  ResponsesStreamTranslator,
} from "../src/responses";

function rawText(chunks: Uint8Array[]): string {
  return new TextDecoder().decode(
    new Uint8Array(chunks.flatMap((chunk) => [...chunk])),
  );
}

function decodeEvents(chunks: Uint8Array[]): any[] {
  return rawText(chunks)
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

  // T1: the raw stream must terminate with the `[DONE]` marker and
  // `response.completed` must be the final JSON event (decodeEvents strips
  // `[DONE]`, so a regression that dropped either would otherwise pass).
  test("terminates with response.completed then a [DONE] marker", () => {
    const translator = new ResponsesStreamTranslator({
      model: "glm-5.2",
      input: "Say OK",
      stream: true,
    });
    const chunks = [
      ...translator.start(),
      ...translator.applyChunk({ choices: [{ delta: { content: "OK" } }] }),
      ...translator.finish(),
    ];
    expect(rawText(chunks).endsWith("data: [DONE]\n\n")).toBe(true);
    const events = decodeEvents(chunks);
    expect(events.at(-1)?.type).toBe("response.completed");
  });

  // T3 / B2: reasoning stream emits the full, ordered lifecycle — including
  // reasoning_summary_part.done, so every *_part.added has a matching *_part.done.
  test("emits the full reasoning summary event lifecycle in order", () => {
    const translator = new ResponsesStreamTranslator({
      model: "glm-5.2",
      input: "think",
      stream: true,
    });
    const types = decodeEvents([
      ...translator.start(),
      ...translator.applyChunk({
        choices: [{ delta: { reasoning_content: "because" } }],
      }),
      ...translator.finish(),
    ]).map((event) => event.type);

    const sequence = [
      "response.reasoning_summary_part.added",
      "response.reasoning_summary_text.delta",
      "response.reasoning_summary_text.done",
      "response.reasoning_summary_part.done",
      "response.output_item.done",
    ];
    const indices = sequence.map((type) => types.indexOf(type));
    indices.forEach((index, i) => {
      expect(index).toBeGreaterThanOrEqual(0); // present
      if (i > 0) {
        expect(index).toBeGreaterThan(indices[i - 1] ?? -1); // in order
      }
    });
  });

  // B2 (failure path): a reasoning part opened before a mid-stream failure is
  // still closed with reasoning_summary_part.done.
  test("closes the reasoning summary part when the stream fails", () => {
    const translator = new ResponsesStreamTranslator({
      model: "glm-5.2",
      input: "think",
      stream: true,
    });
    const types = decodeEvents([
      ...translator.start(),
      ...translator.applyChunk({
        choices: [{ delta: { reasoning_content: "because" } }],
      }),
      ...translator.fail(500, "boom"),
    ]).map((event) => event.type);

    expect(
      types.filter((t) => t === "response.reasoning_summary_part.added").length,
    ).toBe(1);
    expect(
      types.filter((t) => t === "response.reasoning_summary_part.done").length,
    ).toBe(1);
  });

  // T4: intermediate output_item.done events are emitted for text and tool
  // items (not only the final response.completed.output).
  test("emits output_item.done for text and tool-call items", () => {
    const translator = new ResponsesStreamTranslator({
      model: "glm-5.2",
      input: "weather",
      stream: true,
    });
    const events = decodeEvents([
      ...translator.start(),
      ...translator.applyChunk({ choices: [{ delta: { content: "hi" } }] }),
      ...translator.applyChunk({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  id: "call_1",
                  index: 0,
                  type: "function",
                  function: { name: "get_weather", arguments: "{}" },
                },
              ],
            },
          },
        ],
      }),
      ...translator.finish(),
    ]);

    const done = events.filter((e) => e.type === "response.output_item.done");
    expect(done.some((e) => e.item?.type === "message")).toBe(true);
    expect(
      done.some((e) => e.item?.type === "function_call" && e.item.id === "call_1"),
    ).toBe(true);
    for (const e of done) {
      expect(typeof e.output_index).toBe("number");
      expect(e.item?.id).toBeTruthy();
    }
  });

  // T9: two parallel tool calls in one chunk map to two distinct output items.
  test("handles multiple parallel tool calls in a single chunk", () => {
    const translator = new ResponsesStreamTranslator({
      model: "glm-5.2",
      input: "tools",
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
                  id: "call_a",
                  index: 0,
                  type: "function",
                  function: { name: "alpha", arguments: "{\"a\":1}" },
                },
                {
                  id: "call_b",
                  index: 1,
                  type: "function",
                  function: { name: "beta", arguments: "{\"b\":2}" },
                },
              ],
            },
          },
        ],
      }),
      ...translator.finish(),
    ]);

    const completed = events.find((e) => e.type === "response.completed");
    const calls = completed.response.output.filter(
      (item: any) => item.type === "function_call",
    );
    expect(calls).toHaveLength(2);
    expect(calls.map((c: any) => c.name).sort()).toEqual(["alpha", "beta"]);
    expect(calls.find((c: any) => c.id === "call_a").arguments).toBe("{\"a\":1}");
    expect(calls.find((c: any) => c.id === "call_b").arguments).toBe("{\"b\":2}");
  });

  // W1: a mid-stream failure closes already-opened items before response.failed,
  // so the event stream stays balanced (no output_item.added without a .done).
  test("closes in-progress items when the stream fails mid-flight", () => {
    const translator = new ResponsesStreamTranslator({
      model: "glm-5.2",
      input: "hi",
      stream: true,
    });
    const events = decodeEvents([
      ...translator.start(),
      ...translator.applyChunk({ choices: [{ delta: { content: "partial" } }] }),
      ...translator.fail(500, "boom"),
    ]);
    const types = events.map((e) => e.type);

    const doneIndex = types.indexOf("response.output_item.done");
    const failedIndex = types.indexOf("response.failed");
    expect(doneIndex).toBeGreaterThanOrEqual(0);
    expect(failedIndex).toBeGreaterThan(doneIndex);
    expect(types).not.toContain("response.completed");
    const doneItem = events[doneIndex].item;
    expect(doneItem.type).toBe("message");
    expect(doneItem.status).toBe("incomplete");
  });

  // T2: content_filter finish_reason routes finish() to a failure, not completed.
  test("content_filter finish_reason yields response.failed, not completed", () => {
    const translator = new ResponsesStreamTranslator({
      model: "glm-5.2",
      input: "hi",
      stream: true,
    });
    const events = decodeEvents([
      ...translator.start(),
      ...translator.applyChunk({ choices: [{ finish_reason: "content_filter" }] }),
      ...translator.finish(),
    ]);
    const types = events.map((e) => e.type);
    expect(types).toContain("response.failed");
    expect(types).not.toContain("response.completed");
  });

  // T2: an ordinary stop/length finish_reason completes normally.
  test("stop finish_reason completes normally", () => {
    const translator = new ResponsesStreamTranslator({
      model: "glm-5.2",
      input: "hi",
      stream: true,
    });
    const events = decodeEvents([
      ...translator.start(),
      ...translator.applyChunk({
        choices: [{ delta: { content: "hi" }, finish_reason: "stop" }],
      }),
      ...translator.finish(),
    ]);
    const types = events.map((e) => e.type);
    expect(types).toContain("response.completed");
    expect(types).not.toContain("response.failed");
  });
});

describe("ResponsesStreamTranslator failure output", () => {
  // T2: fail() emits a Codex error envelope followed by the [DONE] marker.
  test("fail() emits response.failed with the error envelope and [DONE]", () => {
    const translator = new ResponsesStreamTranslator({
      model: "glm-5.2",
      input: "hi",
      stream: true,
    });
    const chunks = translator.fail(502, "boom");
    expect(rawText(chunks).endsWith("data: [DONE]\n\n")).toBe(true);
    const events = decodeEvents(chunks);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("response.failed");
    expect(events[0].response.error.code).toBe("502");
    expect(events[0].response.error.message).toBe("boom");
  });

  // W7: a stream has exactly one terminal event — a second finish()/fail() after
  // the stream is already finished emits nothing (no duplicate completed/[DONE]).
  test("finish()/fail() are idempotent after the stream is finished", () => {
    const t1 = new ResponsesStreamTranslator({ model: "glm-5.2", input: "hi" });
    t1.start();
    expect(decodeEvents(t1.finish()).length).toBeGreaterThan(0);
    expect(t1.finish()).toHaveLength(0); // second finish → no events
    expect(t1.fail(500, "late")).toHaveLength(0); // fail after finish → nothing

    const t2 = new ResponsesStreamTranslator({ model: "glm-5.2", input: "hi" });
    t2.start();
    expect(decodeEvents(t2.fail(502, "boom")).length).toBeGreaterThan(0);
    expect(t2.finish()).toHaveLength(0); // finish after fail → nothing
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

  // T8: an upstream tool call with no id gets a synthesized id (matching the
  // streaming path) so Codex can correlate the later function_call_output.
  test("synthesizes an id for a non-streaming tool call missing one", () => {
    const chat = {
      id: "chatcmpl_1",
      model: "glm-5.2",
      choices: [
        {
          message: {
            tool_calls: [
              { type: "function", function: { name: "echo", arguments: "{}" } },
            ],
          },
        },
      ],
    } as any;
    const response = chatCompletionToResponse(chat, {
      model: "glm-5.2",
      input: "tool",
    });

    const item = (response.output as any[])[0];
    expect(item.type).toBe("function_call");
    expect(typeof item.id).toBe("string");
    expect(item.id.length).toBeGreaterThan(0);
    expect(item.call_id).toBe(item.id);
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

  // T5: pin the exact idle-timeout message shape and that the iterator is done
  // after the throw (a format change keeping the substring would slip past the
  // toContain assertion above).
  test("idle timeout throws an exact message and ends the iterator", async () => {
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

    expect(message).toBe("upstream SSE idle timeout after 5ms for req_test");
    const after = await iterator.next();
    expect(after.done).toBe(true);
  });

  // B1: events framed with CRLF (`\r\n\r\n`) must still split into chunks —
  // `indexOf("\n\n")` alone never matches a CRLF boundary.
  test("parses CRLF-framed SSE events", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            'data: {"choices":[{"delta":{"content":"O"}}]}\r\n\r\n' +
              'data: {"choices":[{"delta":{"content":"K"}}]}\r\n\r\n' +
              "data: [DONE]\r\n\r\n",
          ),
        );
        controller.close();
      },
    });

    const contents: string[] = [];
    for await (const chunk of parseChatCompletionSse(stream)) {
      const delta = chunk.choices?.[0]?.delta?.content;
      if (delta) {
        contents.push(delta);
      }
    }
    expect(contents.join("")).toBe("OK");
  });
});
