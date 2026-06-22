import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  ALIAS_BLOCK_END,
  ALIAS_BLOCK_START,
  DEFAULT_HOST,
  DEFAULT_MODEL,
  DEFAULT_PORT,
  DEFAULT_PROFILE_NAME,
  DEFAULT_PROVIDER_ID,
} from "./constants";

export interface InstallOptions {
  home?: string;
  port?: number;
  host?: string;
  zodexBin?: string;
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
  return [
    `model = "${DEFAULT_MODEL}"`,
    `model_provider = "${DEFAULT_PROVIDER_ID}"`,
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

export async function install(options: InstallOptions = {}): Promise<{
  profilePath: string;
  zshrcPath: string;
  warnings: string[];
}> {
  const home = options.home ?? homedir();
  const zodexBin = options.zodexBin ?? defaultZodexBin();
  const codexDir = join(home, ".codex");
  const profilePath = join(codexDir, `${DEFAULT_PROFILE_NAME}.config.toml`);
  const zshrcPath = join(home, ".zshrc");
  const backupPath = `${zshrcPath}.zodex.bak`;

  await mkdir(codexDir, { recursive: true });
  await writeAtomic(profilePath, codexProfileToml(options));

  const currentZshrc = await readText(zshrcPath);
  if (currentZshrc && !(await exists(backupPath))) {
    await copyFile(zshrcPath, backupPath);
  }
  const warnings = aliasConflictWarnings(currentZshrc);
  const updatedZshrc = upsertMarkedBlock(currentZshrc, aliasBlock(zodexBin));
  await writeAtomic(zshrcPath, updatedZshrc);

  return { profilePath, zshrcPath, warnings };
}

export async function uninstall(options: InstallOptions = {}): Promise<{
  profilePath: string;
  zshrcPath: string;
}> {
  const home = options.home ?? homedir();
  const codexDir = join(home, ".codex");
  const profilePath = join(codexDir, `${DEFAULT_PROFILE_NAME}.config.toml`);
  const zshrcPath = join(home, ".zshrc");
  const currentZshrc = await readText(zshrcPath);
  await writeAtomic(zshrcPath, removeMarkedBlock(currentZshrc));
  return { profilePath, zshrcPath };
}
