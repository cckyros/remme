// Shared helpers for the install targets. Every write follows the same rules:
// files and entries are OURS only when they carry our marker or key; existing
// files are backed up to <file>.bak before the first change; JSON is merged key
// by key; unparseable files are reported as "manual" and left untouched.
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { manifest } from "../plugin/manifest.ts";

export type Kind = "native" | "skill" | "plugin";
export type Status = "ok" | "manual" | "skipped" | "error";
export interface Result { status: Status; detail: string }
export interface Ctx { dir: string; home: string; scope: "project" | "global"; dryRun: boolean }
export type Json = Record<string, unknown>;

const { name, markers } = manifest;

/** Absolute path of the running CLI bundle (dist/cli.js). MCP entries use
 *  process.execPath + this path, so they never depend on the npm registry. */
export const cliPath = fileURLToPath(import.meta.url);
export const pkgRoot = resolve(cliPath, "..", "..");
export const claudeEntry = (): Json => ({ command: process.execPath, args: [cliPath, "mcp"] });
export const stdioEntry = (): Json => ({ type: "stdio", ...claudeEntry() });
export const localEntry = (): Json => ({ type: "local", command: [process.execPath, cliPath, "mcp"], enabled: true });

export const ok = (detail: string): Result => ({ status: "ok", detail });
export const manual = (detail: string): Result => ({ status: "manual", detail });
export const skipped = (detail: string): Result => ({ status: "skipped", detail });
export const error = (detail: string): Result => ({ status: "error", detail });

/** Worst status wins (error > manual > skipped > ok); details are joined. */
export function combine(results: Result[]): Result {
  const rank: Status[] = ["error", "manual", "skipped", "ok"];
  const status = rank.find((s) => results.some((r) => r.status === s)) ?? "ok";
  return { status, detail: results.map((r) => r.detail).join("; ") };
}

export const read = (file: string): string | null => (existsSync(file) ? readFileSync(file, "utf8") : null);
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Write a file only when its content changes. Returns a short report label. */
export function write(file: string, content: string, dryRun: boolean): string {
  const prev = read(file);
  if (prev === content) return "unchanged";
  if (dryRun) return "would write";
  if (prev !== null) copyFileSync(file, `${file}.bak`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content, "utf8");
  return prev === null ? "created" : "updated (backup: .bak)";
}

// ---------------------------------------------------------------- JSON entries

/** Set the value at `path` inside a JSON file (idempotent, sibling keys kept). */
export function setJson(file: string, path: string[], value: unknown, dryRun: boolean): Result {
  const raw = read(file);
  let data: Json = {};
  if (raw !== null) {
    try { data = JSON.parse(raw); } catch { return manual(`${file} is not valid JSON (comments are not supported) — left untouched`); }
    if (!isObj(data)) return manual(`${file} is not a JSON object — left untouched`);
  }
  let node = data;
  for (const [i, key] of path.slice(0, -1).entries()) {
    node[key] ??= {};
    if (!isObj(node[key])) return manual(`"${path.slice(0, i + 1).join(".")}" in ${file} is not an object — left untouched`);
    node = node[key] as Json;
  }
  const last = path[path.length - 1];
  const label = path.join(".");
  if (JSON.stringify(node[last]) === JSON.stringify(value)) return ok(`${file}: ${label} already configured (idempotent)`);
  node[last] = value;
  return ok(`${file}: ${label} ${write(file, JSON.stringify(data, null, 2) + "\n", dryRun)}`);
}

/** Remove the value at `path`; empty parent objects we leave behind are pruned. */
export function dropJson(file: string, path: string[], dryRun: boolean): Result {
  const raw = read(file);
  if (raw === null) return ok(`${file}: not present`);
  let data: Json;
  try { data = JSON.parse(raw); } catch { return manual(`${file} is not valid JSON — left untouched`); }
  const chain: Json[] = [data];
  for (const key of path.slice(0, -1)) {
    const next = chain[chain.length - 1][key];
    if (!isObj(next)) return ok(`${file}: no ${path.join(".")} entry`);
    chain.push(next);
  }
  const last = path[path.length - 1];
  const parent = chain[chain.length - 1];
  if (!(last in parent)) return ok(`${file}: no ${path.join(".")} entry`);
  delete parent[last];
  for (let i = chain.length - 1; i > 0; i--) {
    if (Object.keys(chain[i]).length) break;
    delete chain[i - 1][path[i - 1]];
  }
  return ok(`${file}: removed ${path.join(".")} ${write(file, JSON.stringify(data, null, 2) + "\n", dryRun)}`);
}

// ---------------------------------------------------------------- text blocks

/** Insert or replace a block between start/end markers (AGENTS.md, config.toml). */
export function upsertBlock(file: string, start: string, end: string, body: string, dryRun: boolean): Result {
  const block = `${start}\n${body.trim()}\n${end}`;
  const raw = read(file) ?? "";
  const re = new RegExp(`${esc(start)}[\\s\\S]*?${esc(end)}`);
  const next = re.test(raw) ? raw.replace(re, block) : `${raw.trimEnd()}${raw.trim() ? "\n\n" : ""}${block}\n`;
  return ok(`${file}: managed block ${write(file, next, dryRun)}`);
}

export function removeBlock(file: string, start: string, end: string, dryRun: boolean): Result {
  const raw = read(file);
  if (raw === null || !raw.includes(start)) return ok(`${file}: no managed block`);
  const next = raw.replace(new RegExp(`\\n*${esc(start)}[\\s\\S]*?${esc(end)}\\n?`), "");
  return ok(`${file}: removed managed block ${write(file, next, dryRun)}`);
}

// ---------------------------------------------------------------- files and skills

/** Write a whole file that we own (marker in content). User files are kept. */
export function upsertFile(file: string, content: string, marker: string, dryRun: boolean): Result {
  const raw = read(file);
  if (raw !== null && !raw.includes(marker)) return skipped(`${file} exists without our marker (user-authored) — kept`);
  return ok(`${file}: ${write(file, content, dryRun)}`);
}

export function removeFile(file: string, marker: string, dryRun: boolean): Result {
  const raw = read(file);
  if (raw === null) return ok(`${file}: not present`);
  if (!raw.includes(marker)) return skipped(`${file} exists without our marker (user-authored) — kept`);
  if (!dryRun) rmSync(file, { force: true });
  return ok(`${file}: ${dryRun ? "would delete" : "deleted"}`);
}

/** Packaged skill (skills/<dir>/SKILL.md, generated by build.mjs). */
export function installSkill(dir: string, dryRun: boolean): Result {
  const src = read(join(pkgRoot, "skills", markers.skillDir, "SKILL.md"));
  if (src === null) return error("skills/remme/SKILL.md missing — run `npm run build` first");
  return upsertFile(join(dir, "SKILL.md"), src, markers.skill, dryRun);
}

export function uninstallSkill(dir: string, dryRun: boolean): Result {
  const r = removeFile(join(dir, "SKILL.md"), markers.skill, dryRun);
  if (r.status === "ok" && !dryRun && existsSync(dir) && readdirSync(dir).length === 0) rmSync(dir, { recursive: true });
  return r;
}

/** Agent Plugins package dir (~/.remme/plugin): plugin.json, skills/ and
 *  mcp.json/.mcp.json carrying the absolute server entry for this machine. */
export function materialize(home: string, dryRun: boolean): string {
  const dir = join(home, markers.configDir, "plugin");
  if (dryRun) return dir;
  mkdirSync(dir, { recursive: true });
  copyFileSync(join(pkgRoot, "plugin.json"), join(dir, "plugin.json"));
  cpSync(join(pkgRoot, "skills"), join(dir, "skills"), { recursive: true, force: true });
  const mcp = JSON.stringify({ mcpServers: { [name]: stdioEntry() } }, null, 2) + "\n";
  write(join(dir, "mcp.json"), mcp, false);
  write(join(dir, ".mcp.json"), mcp, false);
  return dir;
}

export function pluginReady(): Result | null {
  return existsSync(join(pkgRoot, "plugin.json")) && existsSync(join(pkgRoot, "skills"))
    ? null
    : error("plugin.json or skills/ missing — run `npm run build` first");
}

// ---------------------------------------------------------------- external CLIs

export function hasCli(bin: string): boolean {
  const probe = process.platform === "win32" ? "where" : "which";
  return spawnSync(probe, [bin], { stdio: "ignore", windowsHide: true }).status === 0;
}

/** Run a client CLI. Never throws; returns the exit code and trimmed output. */
export function runCli(bin: string, args: string[]): { code: number; out: string } {
  const win = process.platform === "win32";
  const r = spawnSync(bin, win ? args.map((a) => (/\s/.test(a) ? `"${a}"` : a)) : args, {
    encoding: "utf8", shell: win, windowsHide: true, timeout: 60_000,
  });
  return { code: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim().slice(0, 300) };
}
