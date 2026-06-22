import { describe, expect, test } from "bun:test";
import { parseCodexOptions, parseLeadingOptions } from "../src/cli";

describe("cli option parsing", () => {
  test("parses leading debug options before the command", () => {
    const env: Record<string, string | undefined> = {};
    const args = parseLeadingOptions(
      [
        "--debug=trace",
        "--debug-file",
        "/tmp/zodex.log",
        "--upstream-fetch-timeout-ms=30000",
        "serve",
      ],
      env,
    );

    expect(args).toEqual(["serve"]);
    expect(env.ZODEX_DEBUG).toBe("trace");
    expect(env.ZODEX_DEBUG_FILE).toBe("/tmp/zodex.log");
    expect(env.ZODEX_UPSTREAM_FETCH_TIMEOUT_MS).toBe("30000");
  });

  test("supports trailing serve debug options via a second parse pass", () => {
    const env: Record<string, string | undefined> = {};
    const args = parseLeadingOptions(["serve", "--debug"], env);
    const serveOptions = parseLeadingOptions(args.slice(1), env);

    expect(args[0]).toBe("serve");
    expect(serveOptions).toEqual([]);
    expect(env.ZODEX_DEBUG).toBe("1");
  });

  test("parses only zodex-prefixed options before Codex args begin", () => {
    const env: Record<string, string | undefined> = {};
    const args = parseCodexOptions(
      [
        "--zodex-debug=trace",
        "--zodex-stream-idle-timeout-ms=30000",
        "exec",
        "--zodex-debug",
        "prompt",
      ],
      env,
    );

    expect(args).toEqual(["exec", "--zodex-debug", "prompt"]);
    expect(env.ZODEX_DEBUG).toBe("trace");
    expect(env.ZODEX_STREAM_IDLE_TIMEOUT_MS).toBe("30000");
  });
});
