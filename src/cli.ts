import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DEFAULT_PROFILE_NAME } from "./constants";
import { install, uninstall } from "./install";
import { serve } from "./server";
import { runtimeConfigFromEnv } from "./upstream";

function usage(): void {
  console.log(`zodex

Usage:
  zodex serve       Start the local Responses bridge
  zodex install     Write Codex profile and zsh aliases
  zodex uninstall   Remove the managed zsh alias block
  zodex codex ...   Ensure the bridge is up, then exec Codex with GLM 5.2
  zodex build       Build a standalone executable at dist/zodex
  zodex help        Show this help
`);
}

async function healthcheck(url: string): Promise<boolean> {
  try {
    const response = await fetch(url);
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForHealthy(url: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await healthcheck(url)) {
      return;
    }
    await Bun.sleep(100);
  }
  throw new Error(`zodex server did not become healthy at ${url}`);
}

function serverCommand(): { command: string; args: string[] } {
  const executableName = basename(process.execPath);
  if (executableName === "bun" || executableName === "bun-debug") {
    const entrypoint = process.argv[1] || new URL("../index.ts", import.meta.url).pathname;
    return { command: process.execPath, args: [entrypoint, "serve"] };
  }
  return { command: process.execPath, args: ["serve"] };
}

function spawnDetachedServer(): void {
  const { command, args } = serverCommand();
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
    env: process.env,
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

async function runCodex(args: string[]): Promise<number> {
  const config = runtimeConfigFromEnv();
  const healthUrl = `http://${config.host}:${config.port}/health`;
  if (!(await healthcheck(healthUrl))) {
    spawnDetachedServer();
    await waitForHealthy(healthUrl);
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
      env: process.env,
    },
  );
  return await new Promise((resolve) => {
    codex.on("exit", (code) => resolve(code ?? 1));
    codex.on("error", () => resolve(1));
  });
}

export async function main(args: string[]): Promise<void> {
  const command = args[0] ?? "help";

  if (command === "help" || command === "--help" || command === "-h") {
    usage();
    return;
  }

  if (command === "serve") {
    const config = runtimeConfigFromEnv();
    const server = serve(config);
    console.error(
      `zodex listening on http://${server.hostname}:${server.port} -> ${config.upstreamBaseUrl}`,
    );
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
        env: process.env,
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
    const code = await runCodex(args.slice(1));
    process.exitCode = code;
    return;
  }

  console.error(`Unknown command: ${command}`);
  usage();
  process.exitCode = 2;
}
