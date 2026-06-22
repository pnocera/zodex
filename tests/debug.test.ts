import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { createDebugLogger, debugConfigFromEnv } from "../src/debug";
import { runtimeConfigFromEnv } from "../src/upstream";

describe("debug config", () => {
  test("debug mode defaults to file logging and debug timeouts", () => {
    const config = runtimeConfigFromEnv({
      ZODEX_DEBUG: "1",
      ZAI_API_KEY: "secret",
    });

    expect(config.debug.enabled).toBe(true);
    expect(config.debug.trace).toBe(false);
    expect(config.debug.filePath).toContain(".zodex/debug.log");
    expect(config.upstreamFetchTimeoutMs).toBe(120_000);
    expect(config.streamIdleTimeoutMs).toBe(120_000);
  });

  test("trace mode and explicit files are parsed from env", () => {
    const config = debugConfigFromEnv({
      ZODEX_DEBUG: "trace",
      ZODEX_DEBUG_FILE: "/tmp/zodex.log",
    });

    expect(config).toEqual({
      enabled: true,
      trace: true,
      filePath: "/tmp/zodex.log",
    });
  });

  test("logger redacts credentials and writes json lines", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zodex-debug-"));
    const filePath = join(dir, "debug.log");
    try {
      const logger = createDebugLogger({
        enabled: true,
        trace: false,
        filePath,
      });

      logger.log("test.event", {
        authorization: "Bearer secret",
        nested: { api_key: "secret", ok: true },
        max_output_tokens: 256,
      });

      const line = (await readFile(filePath, "utf8")).trim();
      const parsed = JSON.parse(line);
      expect(parsed.event).toBe("test.event");
      expect(parsed.authorization).toBe("[redacted]");
      expect(parsed.nested.api_key).toBe("[redacted]");
      expect(parsed.nested.ok).toBe(true);
      expect(parsed.max_output_tokens).toBe(256);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
