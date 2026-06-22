import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface DebugConfig {
  enabled: boolean;
  trace: boolean;
  filePath?: string;
}

export interface DebugLogger {
  enabled: boolean;
  trace: boolean;
  filePath?: string;
  log(
    event: string,
    data?: Record<string, unknown> | (() => Record<string, unknown>),
    level?: "info" | "trace",
  ): void;
}

type Env = Record<string, string | undefined>;

function isTruthy(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  return !["0", "false", "off", "no"].includes(value.toLowerCase());
}

export function defaultDebugFilePath(home = homedir()): string {
  return join(home, ".zodex", "debug.log");
}

export function debugConfigFromEnv(env: Env = process.env): DebugConfig {
  const raw = env.ZODEX_DEBUG;
  const enabled = isTruthy(raw);
  const trace = enabled && (raw === "trace" || isTruthy(env.ZODEX_DEBUG_TRACE));
  return {
    enabled,
    trace,
    filePath: enabled ? env.ZODEX_DEBUG_FILE || defaultDebugFilePath() : undefined,
  };
}

function truncateString(value: string): string {
  const max = 2000;
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max)}...[truncated ${value.length - max} chars]`;
}

function sanitize(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") {
    return truncateString(value);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  if (seen.has(value)) {
    return "[circular]";
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => sanitize(item, seen));
  }
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (isSensitiveKey(key)) {
      output[key] = "[redacted]";
      continue;
    }
    output[key] = sanitize(item, seen);
  }
  return output;
}

function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  return (
    lower === "authorization" ||
    lower === "api-key" ||
    lower === "api_key" ||
    lower === "apikey" ||
    lower.endsWith("_api_key") ||
    lower.endsWith("-api-key") ||
    lower.includes("secret") ||
    lower.includes("password") ||
    lower === "token" ||
    lower.endsWith("_token") ||
    lower.endsWith("-token")
  );
}

export function createDebugLogger(
  config: DebugConfig,
  baseFields: Record<string, unknown> = {},
): DebugLogger {
  if (config.enabled && config.filePath) {
    try {
      mkdirSync(dirname(config.filePath), { recursive: true });
    } catch (error) {
      process.stderr.write(
        `[zodex] failed to create debug log directory ${dirname(config.filePath)}: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
    }
  }

  function write(line: string): void {
    process.stderr.write(`${line}\n`);
    if (!config.filePath) {
      return;
    }
    try {
      appendFileSync(config.filePath, `${line}\n`, "utf8");
    } catch (error) {
      process.stderr.write(
        `[zodex] failed to write debug log ${config.filePath}: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
    }
  }

  return {
    enabled: config.enabled,
    trace: config.trace,
    filePath: config.filePath,
    log(event, data = {}, level = "info") {
      if (!config.enabled || (level === "trace" && !config.trace)) {
        return;
      }
      const fields = typeof data === "function" ? data() : data;
      const payload = {
        ts: new Date().toISOString(),
        level,
        pid: process.pid,
        event,
        ...baseFields,
        ...fields,
      };
      write(JSON.stringify(sanitize(payload)));
    },
  };
}
