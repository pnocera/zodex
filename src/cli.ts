import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DEFAULT_PROFILE_NAME } from "./constants";
import { debugConfigFromEnv } from "./debug";
import { install, uninstall } from "./install";
import { serve } from "./server";
import { runtimeConfigFromEnv } from "./upstream";

function usage(): void {
  console.log(`zodex

Usage:
  zodex --debug serve
  zodex serve       Start the local Responses bridge
  zodex install     Write Codex profile and zsh aliases
  zodex uninstall   Remove the managed zsh alias block
  zodex codex ...   Ensure the bridge is up, then exec Codex with GLM 5.2
  zodex build       Build a standalone executable at dist/zodex
  zodex help        Show this help

Debug:
  ZODEX_DEBUG=1 cxz exec ...
  zodex --debug=trace serve
  zodex codex --zodex-debug exec ...
`);
}

type Env = Record<string, string | undefined>;

interface HealthState {
  ok?: boolean;
  model?: string;
  debug?: {
    enabled?: boolean;
    trace?: boolean;
    file?: string | null;
  };
  upstream_fetch_timeout_ms?: number;
  stream_idle_timeout_ms?: number;
}

function cloneEnv(): Env {
  return { ...process.env };
}

export function parseLeadingOptions(args: string[], env: Env): string[] {
  const remaining = [...args];
  while (remaining.length > 0) {
    const arg = remaining[0];
    if (arg === "--debug") {
      env.ZODEX_DEBUG = env.ZODEX_DEBUG || "1";
      remaining.shift();
      continue;
    }
    if (arg?.startsWith("--debug=")) {
      env.ZODEX_DEBUG = arg.slice("--debug=".length) || "1";
      remaining.shift();
      continue;
    }
    if (arg === "--debug-file") {
      remaining.shift();
      env.ZODEX_DEBUG_FILE = remaining.shift();
      continue;
    }
    if (arg?.startsWith("--debug-file=")) {
      env.ZODEX_DEBUG_FILE = arg.slice("--debug-file=".length);
      remaining.shift();
      continue;
    }
    if (arg === "--stream-idle-timeout-ms") {
      remaining.shift();
      env.ZODEX_STREAM_IDLE_TIMEOUT_MS = remaining.shift();
      continue;
    }
    if (arg?.startsWith("--stream-idle-timeout-ms=")) {
      env.ZODEX_STREAM_IDLE_TIMEOUT_MS = arg.slice(
        "--stream-idle-timeout-ms=".length,
      );
      remaining.shift();
      continue;
    }
    if (arg === "--upstream-fetch-timeout-ms") {
      remaining.shift();
      env.ZODEX_UPSTREAM_FETCH_TIMEOUT_MS = remaining.shift();
      continue;
    }
    if (arg?.startsWith("--upstream-fetch-timeout-ms=")) {
      env.ZODEX_UPSTREAM_FETCH_TIMEOUT_MS = arg.slice(
        "--upstream-fetch-timeout-ms=".length,
      );
      remaining.shift();
      continue;
    }
    break;
  }
  return remaining;
}

export function parseCodexOptions(args: string[], env: Env): string[] {
  const remaining = [...args];
  while (remaining.length > 0) {
    const arg = remaining[0];
    if (!arg) {
      remaining.shift();
      continue;
    }
    if (arg === "--zodex-debug") {
      env.ZODEX_DEBUG = env.ZODEX_DEBUG || "1";
      remaining.shift();
      continue;
    }
    if (arg.startsWith("--zodex-debug=")) {
      env.ZODEX_DEBUG = arg.slice("--zodex-debug=".length) || "1";
      remaining.shift();
      continue;
    }
    if (arg === "--zodex-debug-file") {
      remaining.shift();
      env.ZODEX_DEBUG_FILE = remaining.shift();
      continue;
    }
    if (arg.startsWith("--zodex-debug-file=")) {
      env.ZODEX_DEBUG_FILE = arg.slice("--zodex-debug-file=".length);
      remaining.shift();
      continue;
    }
    if (arg === "--zodex-stream-idle-timeout-ms") {
      remaining.shift();
      env.ZODEX_STREAM_IDLE_TIMEOUT_MS = remaining.shift();
      continue;
    }
    if (arg.startsWith("--zodex-stream-idle-timeout-ms=")) {
      env.ZODEX_STREAM_IDLE_TIMEOUT_MS = arg.slice(
        "--zodex-stream-idle-timeout-ms=".length,
      );
      remaining.shift();
      continue;
    }
    if (arg === "--zodex-upstream-fetch-timeout-ms") {
      remaining.shift();
      env.ZODEX_UPSTREAM_FETCH_TIMEOUT_MS = remaining.shift();
      continue;
    }
    if (arg.startsWith("--zodex-upstream-fetch-timeout-ms=")) {
      env.ZODEX_UPSTREAM_FETCH_TIMEOUT_MS = arg.slice(
        "--zodex-upstream-fetch-timeout-ms=".length,
      );
      remaining.shift();
      continue;
    }
    break;
  }
  return remaining;
}

async function healthState(url: string): Promise<HealthState | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      return null;
    }
    return (await response.json()) as HealthState;
  } catch {
    return null;
  }
}

async function healthcheck(url: string): Promise<boolean> {
  return (await healthState(url))?.ok === true;
}

async function waitForHealthy(url: string): Promise<HealthState> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const health = await healthState(url);
    if (health?.ok) {
      return health;
    }
    await Bun.sleep(100);
  }
  throw new Error(`zodex server did not become healthy at ${url}`);
}

async function waitForStopped(url: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (!(await healthcheck(url))) {
      return;
    }
    await Bun.sleep(100);
  }
  throw new Error(`zodex server did not stop at ${url}`);
}

async function shutdownServer(config: ReturnType<typeof runtimeConfigFromEnv>): Promise<boolean> {
  try {
    const response = await fetch(`http://${config.host}:${config.port}/__zodex/shutdown`, {
      method: "POST",
    });
    return response.ok;
  } catch {
    return false;
  }
}

function debugConfigMatches(
  config: ReturnType<typeof runtimeConfigFromEnv>,
  health: HealthState,
): boolean {
  if (!config.debug.enabled) {
    return true;
  }
  return (
    health.debug?.enabled === true &&
    health.debug?.trace === config.debug.trace &&
    health.debug?.file === (config.debug.filePath ?? null) &&
    health.upstream_fetch_timeout_ms === config.upstreamFetchTimeoutMs &&
    health.stream_idle_timeout_ms === config.streamIdleTimeoutMs
  );
}

function serverCommand(): { command: string; args: string[] } {
  const executableName = basename(process.execPath);
  if (executableName === "bun" || executableName === "bun-debug") {
    const entrypoint = process.argv[1] || new URL("../index.ts", import.meta.url).pathname;
    return { command: process.execPath, args: [entrypoint, "serve"] };
  }
  return { command: process.execPath, args: ["serve"] };
}

function spawnDetachedServer(env: Env): void {
  const { command, args } = serverCommand();
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
    env,
  });
  (child as unknown as { unref(): void }).unref();
}

function projectRoot(): string {
  const execDir = dirname(process.execPath);
  if (basename(process.execPath) === "zodex" && basename(execDir) === "dist") {
    return dirname(execDir);
  }
  return dirname(new URL("../index.ts", import.meta.url).pathname);
}

function preferredInstallBin(): string {
  const compiled = join(projectRoot(), "dist", "zodex");
  if (existsSync(compiled)) {
    return compiled;
  }
  return join(projectRoot(), "bin", "zodex");
}

async function runCodex(args: string[], env: Env): Promise<number> {
  const config = runtimeConfigFromEnv(env);
  const debug = debugConfigFromEnv(env);
  if (debug.enabled) {
    console.error(`zodex debug log: ${debug.filePath}`);
    console.error(
      `zodex debug timeouts: upstream_fetch=${config.upstreamFetchTimeoutMs || "off"}ms stream_idle=${config.streamIdleTimeoutMs || "off"}ms`,
    );
  }
  const healthUrl = `http://${config.host}:${config.port}/health`;
  let health = await healthState(healthUrl);
  if (health?.ok && !debugConfigMatches(config, health)) {
    console.error("zodex restarting existing bridge to apply debug settings");
    if (await shutdownServer(config)) {
      await waitForStopped(healthUrl);
      health = null;
    } else {
      console.error(
        "zodex warning: existing bridge did not accept restart; debug may be inactive until that server is stopped",
      );
    }
  }
  if (!health?.ok) {
    spawnDetachedServer(env);
    health = await waitForHealthy(healthUrl);
  }

  const codex = spawn(
    "codex",
    [
      "--profile",
      DEFAULT_PROFILE_NAME,
      "--dangerously-bypass-approvals-and-sandbox",
      ...args,
    ],
    {
      stdio: "inherit",
      env,
    },
  );
  return await new Promise((resolve) => {
    codex.on("exit", (code) => resolve(code ?? 1));
    codex.on("error", () => resolve(1));
  });
}

export async function main(args: string[]): Promise<void> {
  const env = cloneEnv();
  const parsedArgs = parseLeadingOptions(args, env);
  const command = parsedArgs[0] ?? "help";

  if (command === "help" || command === "--help" || command === "-h") {
    usage();
    return;
  }

  if (command === "serve") {
    const leftover = parseLeadingOptions(parsedArgs.slice(1), env);
    if (leftover.length > 0) {
      console.error(`Unknown serve option: ${leftover[0]}`);
      process.exitCode = 2;
      return;
    }
    const config = runtimeConfigFromEnv(env);
    const server = serve(config);
    console.error(
      `zodex listening on http://${server.hostname}:${server.port} -> ${config.upstreamBaseUrl}`,
    );
    if (config.debug.enabled) {
      console.error(`zodex debug log: ${config.debug.filePath}`);
      console.error(
        `zodex debug timeouts: upstream_fetch=${config.upstreamFetchTimeoutMs || "off"}ms stream_idle=${config.streamIdleTimeoutMs || "off"}ms`,
      );
    }
    await new Promise(() => undefined);
    return;
  }

  if (command === "build") {
    const build = spawn(
      "bun",
      ["build", "--compile", "--outfile", "dist/zodex", "index.ts"],
      {
        cwd: projectRoot(),
        stdio: "inherit",
        env,
      },
    );
    const code = await new Promise<number>((resolve) => {
      build.on("exit", (exitCode) => resolve(exitCode ?? 1));
      build.on("error", () => resolve(1));
    });
    process.exitCode = code;
    return;
  }

  if (command === "install") {
    const result = await install({ zodexBin: preferredInstallBin() });
    console.log(`Wrote ${result.modelCatalogPath}`);
    console.log(`Wrote ${result.profilePath}`);
    console.log(`Updated ${result.zshrcPath}`);
    for (const warning of result.warnings) {
      console.log(`Warning: ${warning}`);
    }
    console.log(
      "Added aliases use --dangerously-bypass-approvals-and-sandbox; run only in trusted directories.",
    );
    console.log("Ensure ZAI_API_KEY is exported in shells that run cxz.");
    return;
  }

  if (command === "uninstall") {
    const result = await uninstall();
    console.log(`Removed managed zodex alias block from ${result.zshrcPath}`);
    console.log(`Left ${result.profilePath} in place for manual removal if desired`);
    return;
  }

  if (command === "codex") {
    const codexArgs = parseCodexOptions(parsedArgs.slice(1), env);
    const code = await runCodex(codexArgs, env);
    process.exitCode = code;
    return;
  }

  console.error(`Unknown command: ${command}`);
  usage();
  process.exitCode = 2;
}
