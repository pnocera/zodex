import { spawn } from "node:child_process";
import {
  copyFile,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  ALIAS_BLOCK_END,
  ALIAS_BLOCK_START,
  DEFAULT_HOST,
  DEFAULT_MODEL,
  DEFAULT_MODEL_CATALOG_FILENAME,
  DEFAULT_PORT,
  DEFAULT_PROFILE_NAME,
  DEFAULT_PROVIDER_ID,
} from "./constants";

export interface InstallOptions {
  home?: string;
  port?: number;
  host?: string;
  zodexBin?: string;
  codexCommand?: string;
  codexBaseInstructions?: string;
  modelCatalogPath?: string;
}

const CODEX_BASE_INSTRUCTION_MODEL_PREFERENCE = [
  "gpt-5.3-codex",
  "gpt-5.2-codex",
  "gpt-5-codex",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.2",
];

const FALLBACK_CODEX_BASE_INSTRUCTIONS =
  "You are Codex, a coding agent running in the Codex CLI. Work directly in the user's workspace, follow the provided developer and repository instructions, use tools carefully, and keep the user informed with concise progress updates.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readText(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return "";
    }
    throw error;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}

async function writeAtomic(path: string, content: string): Promise<void> {
  const tmpPath = `${path}.zodex.${process.pid}.tmp`;
  await writeFile(tmpPath, content, "utf8");
  await rename(tmpPath, path);
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Is the lockfile owned by a process that no longer exists? Only returns true
// when we can POSITIVELY confirm the owning pid is dead, so we never reclaim a
// lock that another run just created (empty/unknown owner → treated as live).
export async function lockIsStale(lockPath: string): Promise<boolean> {
  let content: string;
  try {
    content = (await readFile(lockPath, "utf8")).trim();
  } catch {
    return false; // vanished/unreadable — let the retry loop handle it
  }
  if (!content) {
    return false; // just created; pid not written yet
  }
  const pid = Number(content);
  if (!Number.isInteger(pid) || pid <= 0) {
    return false; // unknown owner — don't reclaim
  }
  try {
    process.kill(pid, 0); // signal 0 = existence check
    return false; // owner alive (or EPERM below means alive under another user)
  } catch (error) {
    return (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ESRCH" // no such process → stale
    );
  }
}

// Serialize the read-modify-write of a shared file (~/.zshrc) across concurrent
// `zodex install`/`uninstall` runs with an advisory O_EXCL lockfile, so two runs
// can't both read the same base content and have the second rename clobber the
// first. The lockfile records the owning pid so a lock left behind by a crashed
// run (SIGKILL bypasses the finally cleanup) is reclaimed immediately instead of
// forcing every later run to wait out the timeout. If the lock is held by a live
// run and can't be taken within ~5s we warn and proceed rather than deadlock.
async function withFileLock<T>(
  targetPath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const lockPath = `${targetPath}.zodex.lock`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      handle = await open(lockPath, "wx");
      await handle.writeFile(String(process.pid), "utf8");
      break;
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "EEXIST"
      ) {
        if (await lockIsStale(lockPath)) {
          await unlink(lockPath).catch(() => undefined);
          continue; // reclaim immediately, no sleep
        }
        await sleep(100);
        continue;
      }
      throw error;
    }
  }
  if (!handle) {
    console.error(
      `zodex: could not acquire ${lockPath} after 5s; proceeding without lock`,
    );
    return fn();
  }
  try {
    return await fn();
  } finally {
    await handle.close().catch(() => undefined);
    await unlink(lockPath).catch(() => undefined);
  }
}

// Keep only the `keep` most recent timestamped `.zodex.bak.<ts>` backups of a
// file so frequent installs don't accumulate them without bound. The stable
// first-ever backup (`<base>` with no numeric suffix) is never touched.
export async function rotateBackups(
  basePath: string,
  keep: number,
): Promise<void> {
  const dir = dirname(basePath);
  const prefix = `${basename(basePath)}.`;
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  const backups = entries
    .filter((name) => name.startsWith(prefix) && /\.\d+$/.test(name))
    .map((name) => ({ name, ts: Number(name.slice(prefix.length)) }))
    .filter((entry) => Number.isFinite(entry.ts))
    .sort((a, b) => b.ts - a.ts); // newest first
  for (const stale of backups.slice(keep)) {
    await unlink(join(dir, stale.name)).catch(() => undefined);
  }
}

function aliasBlock(zodexBin: string): string {
  return [
    ALIAS_BLOCK_START,
    "alias cx='codex --dangerously-bypass-approvals-and-sandbox'",
    `alias cxz='${zodexBin} codex'`,
    ALIAS_BLOCK_END,
  ].join("\n");
}

function defaultZodexBin(): string {
  return new URL("../bin/zodex", import.meta.url).pathname;
}

export function modelCatalogPath(home: string): string {
  return join(home, ".codex", DEFAULT_MODEL_CATALOG_FILENAME);
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

export function codexBaseInstructionsFromCatalog(
  catalog: unknown,
): string | null {
  if (!isRecord(catalog) || !Array.isArray(catalog.models)) {
    return null;
  }

  const models = catalog.models.filter(isRecord);
  for (const slug of CODEX_BASE_INSTRUCTION_MODEL_PREFERENCE) {
    const model = models.find((candidate) => candidate.slug === slug);
    if (
      typeof model?.base_instructions === "string" &&
      model.base_instructions.trim()
    ) {
      return model.base_instructions;
    }
  }

  const firstModel = models.find(
    (candidate) =>
      typeof candidate.base_instructions === "string" &&
      candidate.base_instructions.trim(),
  );
  return typeof firstModel?.base_instructions === "string"
    ? firstModel.base_instructions
    : null;
}

export async function installedCodexBaseInstructions(
  codexCommand = "codex",
): Promise<string | null> {
  return await new Promise((resolve) => {
    const child = spawn(codexCommand, ["debug", "models", "--bundled"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill();
        resolve(null);
      }
    }, 3000);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.resume();
    child.on("error", () => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        resolve(null);
      }
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (code !== 0 || !stdout.trim()) {
        resolve(null);
        return;
      }
      try {
        resolve(codexBaseInstructionsFromCatalog(JSON.parse(stdout)));
      } catch {
        resolve(null);
      }
    });
  });
}

export async function codexBaseInstructionsForCatalog(
  options: InstallOptions = {},
): Promise<string> {
  if (options.codexBaseInstructions?.trim()) {
    return options.codexBaseInstructions;
  }
  return (
    (await installedCodexBaseInstructions(options.codexCommand ?? "codex")) ??
    FALLBACK_CODEX_BASE_INSTRUCTIONS
  );
}

export function upsertMarkedBlock(
  content: string,
  block: string,
  start = ALIAS_BLOCK_START,
  end = ALIAS_BLOCK_END,
): string {
  const startIndex = content.indexOf(start);
  const endIndex = content.indexOf(end);
  let next: string;
  if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
    next = `${content.slice(0, startIndex)}${block}${content.slice(
      endIndex + end.length,
    )}`;
  } else {
    const prefix = content.trimEnd();
    next = prefix ? `${prefix}\n\n${block}\n` : `${block}\n`;
  }
  return `${next.trimEnd()}\n`;
}

export function removeMarkedBlock(
  content: string,
  start = ALIAS_BLOCK_START,
  end = ALIAS_BLOCK_END,
): string {
  const startIndex = content.indexOf(start);
  const endIndex = content.indexOf(end);
  if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) {
    return content;
  }
  return `${content.slice(0, startIndex).trimEnd()}\n${content.slice(endIndex + end.length).trimStart()}`
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd()
    .concat("\n");
}

export function aliasConflictWarnings(content: string): string[] {
  const outsideManagedBlock = content.replace(
    new RegExp(`${ALIAS_BLOCK_START}[\\s\\S]*?${ALIAS_BLOCK_END}`, "m"),
    "",
  );
  const warnings: string[] = [];
  if (/^\s*alias\s+cx=/m.test(outsideManagedBlock)) {
    warnings.push("Existing cx alias outside the zodex managed block was left unchanged.");
  }
  if (/^\s*alias\s+cxz=/m.test(outsideManagedBlock)) {
    warnings.push("Existing cxz alias outside the zodex managed block was left unchanged.");
  }
  return warnings;
}

export function codexProfileToml(options: InstallOptions = {}): string {
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  const catalogPath =
    options.modelCatalogPath ?? modelCatalogPath(options.home ?? homedir());
  return [
    `model = "${DEFAULT_MODEL}"`,
    `model_reasoning_effort = "max"`,
    `model_provider = "${DEFAULT_PROVIDER_ID}"`,
    `model_catalog_json = ${tomlString(catalogPath)}`,
    "",
    `[model_providers.${DEFAULT_PROVIDER_ID}]`,
    `name = "Z.AI GLM 5.2 via zodex"`,
    `base_url = "http://${host}:${port}"`,
    `env_key = "ZAI_API_KEY"`,
    `wire_api = "responses"`,
    `stream_idle_timeout_ms = 3000000`,
    "",
  ].join("\n");
}

export function glm52ModelCatalogJson(baseInstructions: string): string {
  return `${JSON.stringify(
    {
      models: [
        {
          slug: DEFAULT_MODEL,
          display_name: "GLM-5.2",
          description:
            "Z.AI GLM-5.2 coding model with 1M context, 128K max output, text input/output, tool calling, and high/max reasoning effort.",
          default_reasoning_level: "max",
          supported_reasoning_levels: [
            {
              effort: "high",
              description: "Enhanced reasoning for everyday coding tasks",
            },
            {
              effort: "max",
              description: "Maximum reasoning for complex coding tasks",
            },
          ],
          shell_type: "shell_command",
          visibility: "list",
          supported_in_api: true,
          priority: 1,
          additional_speed_tiers: [],
          service_tiers: [],
          availability_nux: null,
          upgrade: null,
          base_instructions: baseInstructions,
          model_messages: null,
          supports_reasoning_summaries: true,
          default_reasoning_summary: "auto",
          support_verbosity: false,
          default_verbosity: null,
          apply_patch_tool_type: null,
          web_search_tool_type: "text",
          truncation_policy: { mode: "tokens", limit: 10000 },
          supports_parallel_tool_calls: true,
          supports_image_detail_original: false,
          context_window: 1000000,
          max_context_window: 1000000,
          effective_context_window_percent: 95,
          experimental_supported_tools: [],
          input_modalities: ["text"],
          supports_search_tool: false,
          use_responses_lite: false,
        },
      ],
    },
    null,
    2,
  )}\n`;
}

export async function install(options: InstallOptions = {}): Promise<{
  modelCatalogPath: string;
  profilePath: string;
  zshrcPath: string;
  warnings: string[];
}> {
  const home = options.home ?? homedir();
  const zodexBin = options.zodexBin ?? defaultZodexBin();
  const codexDir = join(home, ".codex");
  const catalogPath = modelCatalogPath(home);
  const profilePath = join(codexDir, `${DEFAULT_PROFILE_NAME}.config.toml`);
  const zshrcPath = join(home, ".zshrc");
  const backupPath = `${zshrcPath}.zodex.bak`;

  await mkdir(codexDir, { recursive: true });
  const baseInstructions = await codexBaseInstructionsForCatalog(options);
  await writeAtomic(catalogPath, glm52ModelCatalogJson(baseInstructions));
  await writeAtomic(
    profilePath,
    codexProfileToml({ ...options, home, modelCatalogPath: catalogPath }),
  );

  const warnings = await withFileLock(zshrcPath, async () => {
    const currentZshrc = await readText(zshrcPath);
    const conflicts = aliasConflictWarnings(currentZshrc);
    const updatedZshrc = upsertMarkedBlock(currentZshrc, aliasBlock(zodexBin));
    if (updatedZshrc === currentZshrc) {
      return conflicts; // idempotent no-op: nothing to back up or write
    }
    if (currentZshrc) {
      // Keep the first-ever pre-zodex snapshot stable for discovery/uninstall…
      if (!(await exists(backupPath))) {
        await copyFile(zshrcPath, backupPath);
      }
      // …and always add a fresh timestamped backup so a later install never
      // silently loses edits the user made since the last run.
      await copyFile(zshrcPath, `${backupPath}.${Date.now()}`);
      await rotateBackups(backupPath, 5);
    }
    await writeAtomic(zshrcPath, updatedZshrc);
    return conflicts;
  });

  return { modelCatalogPath: catalogPath, profilePath, zshrcPath, warnings };
}

export async function uninstall(options: InstallOptions = {}): Promise<{
  profilePath: string;
  zshrcPath: string;
}> {
  const home = options.home ?? homedir();
  const codexDir = join(home, ".codex");
  const profilePath = join(codexDir, `${DEFAULT_PROFILE_NAME}.config.toml`);
  const zshrcPath = join(home, ".zshrc");
  const backupPath = `${zshrcPath}.zodex.bak`;
  await withFileLock(zshrcPath, async () => {
    const currentZshrc = await readText(zshrcPath);
    const updated = removeMarkedBlock(currentZshrc);
    if (updated === currentZshrc) {
      return; // no managed block present: leave the file untouched
    }
    await copyFile(zshrcPath, `${backupPath}.${Date.now()}`);
    await rotateBackups(backupPath, 5);
    await writeAtomic(zshrcPath, updated);
  });
  return { profilePath, zshrcPath };
}
