import { describe, expect, test } from "bun:test";
import { normalizeToolChoice, translateResponsesRequest } from "../src/translate";

describe("translateResponsesRequest", () => {
  test("merges instructions and developer messages into one system message", () => {
    const translated = translateResponsesRequest({
      model: "glm-5.2",
      instructions: "Base instruction",
      input: [
        { role: "developer", content: "Developer instruction" },
        { role: "user", content: "Hello" },
      ],
    });

    expect(translated.messages[0]).toEqual({
      role: "system",
      content: "Base instruction\n\nDeveloper instruction",
    });
    expect(translated.messages[1]).toEqual({ role: "user", content: "Hello" });
  });

  test("maps function call and function output items", () => {
    const translated = translateResponsesRequest({
      input: [
        {
          type: "function_call",
          call_id: "call_1",
          name: "get_weather",
          arguments: "{\"city\":\"Paris\"}",
        },
        {
          type: "function_call_output",
          call_id: "call_1",
          output: "sunny",
        },
      ],
    });

    expect(translated.messages).toEqual([
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: {
              name: "get_weather",
              arguments: "{\"city\":\"Paris\"}",
            },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "sunny" },
    ]);
  });

  test("normalizes Responses function tools to chat completion tools", () => {
    const translated = translateResponsesRequest({
      input: "hi",
      tools: [
        {
          type: "function",
          name: "get_weather",
          description: "Get weather",
          parameters: { properties: { city: { type: "string" } } },
        },
      ],
    });

    expect(translated.tools).toEqual([
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get weather",
          parameters: {
            type: "object",
            properties: { city: { type: "string" } },
          },
          strict: false,
        },
      },
    ]);
  });

  test("drops Responses-only tool containers before chat completion", () => {
    const translated = translateResponsesRequest({
      input: "hi",
      tools: [
        { type: "namespace", name: "multi_agent_v1", tools: [] },
        { type: "web_search_preview" },
        {
          type: "function",
          name: "shell",
          parameters: { type: "object" },
        },
      ],
    });

    expect(translated.tools).toHaveLength(1);
    expect((translated.tools?.[0] as any).function.name).toBe("shell");
  });

  test("normalizes Cursor style tool_choice", () => {
    expect(normalizeToolChoice({ type: "tool" })).toBe("required");
    expect(normalizeToolChoice({ type: "function", name: "shell" })).toEqual({
      type: "function",
      function: { name: "shell" },
    });
  });

  test("maps reasoning effort to a string when summary is present", () => {
    const translated = translateResponsesRequest({
      input: "hi",
      reasoning: { effort: "medium", summary: "auto" },
    });

    expect(translated.reasoning_effort).toBe("medium");
  });
});
