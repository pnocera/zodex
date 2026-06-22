import { describe, expect, test } from "bun:test";
import { chatCompletionToResponse, ResponsesStreamTranslator } from "../src/responses";

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
});
