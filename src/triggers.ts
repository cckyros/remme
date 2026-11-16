// Pitfall-warning triggers: explicit matching rules stored in memory
// frontmatter (triggerPaths / triggerCommands / triggerKeywords). The hook
// runtime (src/hook.ts) uses this module to decide which confirmed/verified
// memories to surface — never embeddings, never the SQLite store.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { parseMarkdown } from "./chunker.ts";
import type { Config } from "./config.ts";

export interface Triggers {
  paths: string[];
  commands: string[];
  keywords: string[];
}

export interface WarningEntry {
  path: string;
  status: string;
  knowledgeType?: string;
  title: string;
  triggers: Triggers;
}

export interface MatchContext {
  paths?: string[];
  commands?: string[];
  text?: string;
  cwd: string;
}

const ACTIVE_STATUSES = new Set(["confirmed", "verified"]);
const INDEX_TTL_MS = 120_000;
const STATE_TTL_MS = 7 * 24 * 3600_000;
const MAX_SESSIONS = 200;
const MAX_WARNINGS = 3;

export function triggersOf(metadata: {
  triggerPaths?: string[]; triggerCommands?: string[]; triggerKeywords?: string[];
}): Triggers {
  return {
    paths: metadata.triggerPaths ?? [],
    commands: metadata.triggerCommands ?? [],
    keywords: metadata.triggerKeywords ?? [],
  };
}

export function hasTriggers(triggers: Triggers): boolean {
  return triggers.paths.length + triggers.commands.length + triggers.keywords.length > 0;
}

// ---------------------------------------------------------------- matching

/** Glob with `*` (one segment), `**` (any depth) and `?`. No deps. */
export function globToRegExp(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        if (pattern[i + 2] === "/") { re += "(?:.*/)?"; i += 2; }
        else { re += ".*"; i += 1; }
      } else re += "[^/]*";
    } else if (ch === "?") re += "[^/]";
    else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/");
}

/** Candidate spellings of one file path for glob matching. */
function pathCandidates(filePath: string, cwd: string): string[] {
  const posix = normalizePath(filePath);
  const candidates = [posix];
  if (isAbsolute(filePath)) {
    const rel = normalizePath(relative(normalizePath(cwd), posix));
    if (rel && rel !== ".." && !rel.startsWith("../")) candidates.push(rel);
  }
  return candidates;
}

/** True when any pattern matches any of the given file paths. */
export function matchPaths(patterns: string[], filePaths: string[], cwd: string): boolean {
  if (!patterns.length || !filePaths.length) return false;
  const compiled = patterns.map((p) => ({ raw: normalizePath(p), re: globToRegExp(normalizePath(p)) }));
  for (const filePath of filePaths) {
    const candidates = pathCandidates(filePath, cwd);
    const base = normalizePath(filePath).split("/").pop() ?? "";
    for (const { raw, re } of compiled) {
      if (candidates.some((cand) => re.test(cand))) return true;
      // A pattern without a slash also matches the bare file name.
      if (!raw.includes("/") && base && re.test(base)) return true;
    }
  }
  return false;
}

/** True when any regex pattern matches any command string. Bad patterns are skipped. */
export function matchCommands(patterns: string[], commands: string[]): boolean {
  if (!patterns.length || !commands.length) return false;
  const regexes = patterns.flatMap((p) => { try { return [new RegExp(p, "i")]; } catch { return []; } });
  return regexes.some((re) => commands.some((cmd) => re.test(cmd)));
}

/** Case-insensitive substring match; works for CJK keywords. */
export function matchKeywords(keywords: string[], text: string): boolean {
  if (!keywords.length || !text) return false;
  const haystack = text.toLowerCase();
  return keywords.some((kw) => kw && haystack.includes(kw.toLowerCase()));
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Stricter keyword match for command strings. Loose substring hits every
 *  keyword embedded in a path or identifier (`agents.md` inside
 *  `devin\AGENTS.md`, `hook` inside `dist/hook.js`), which flooded warnings
 *  with false positives. A keyword in a command must be "detached": no
 *  word char, slash, backslash, dot or hyphen glued to its left, and no
 *  word char glued to its right — so `WINWORD.EXE`, `gemini-2.0` and
 *  `__list.py` still count, but path-embedded names do not. */
export function matchCommandKeywords(keywords: string[], commands: string[]): boolean {
  if (!keywords.length || !commands.length) return false;
  const text = commands.join("\n");
  return keywords.some((kw) => {
    if (!kw) return false;
    return new RegExp(`(?<![\\w./\\\\-])${escapeRegExp(kw)}(?![\\w])`, "i").test(text);
  });
}

export function matchWarnings(entries: WarningEntry[], ctx: MatchContext, limit = MAX_WARNINGS): WarningEntry[] {
  const out: WarningEntry[] = [];
  for (const entry of entries) {
    const t = entry.triggers;
    const hit =
      (ctx.paths && matchPaths(t.paths, ctx.paths, ctx.cwd)) ||
      (ctx.commands && (matchCommands(t.commands, ctx.commands) || matchCommandKeywords(t.keywords, ctx.commands))) ||
      (ctx.text && matchKeywords(t.keywords, ctx.text));
    if (hit) {
      out.push(entry);
      if (out.length >= limit) break;
    }
  }
  return out;
}

// ---------------------------------------------------------------- index

function scanMarkdown(dir: string): string[] {
  const out: string[] = [];
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name.startsWith(".staging-")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...scanMarkdown(full));
    else if (entry.isFile() && entry.name.endsWith(".md")) out.push(full);
  }
  return out;
}

function titleOf(body: string): string {
  const line = body.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  return line.replace(/\s+/g, " ").slice(0, 120);
}

/** Scan the memory dir and return warning entries (confirmed/verified + triggers). */
export function buildWarningIndex(config: Config): WarningEntry[] {
  const entries: WarningEntry[] = [];
  for (const file of scanMarkdown(config.memoryDir)) {
    let parsed;
    try { parsed = parseMarkdown(readFileSync(file, "utf8"), config.agent); } catch { continue; }
    const m = parsed.metadata;
    if (!ACTIVE_STATUSES.has(m.status)) continue;
    const triggers = triggersOf(m);
    if (!hasTriggers(triggers)) continue;
    entries.push({
      path: relative(config.memoryDir, file).split(sep).join("/"),
      status: m.status,
      knowledgeType: m.knowledgeType,
      title: titleOf(parsed.body),
      triggers,
    });
  }
  return entries;
}

export function indexPath(config: Config): string {
  return join(dirname(config.memoryDir), "warnings-index.json");
}

interface IndexFile { version: number; builtAt: string; entries: WarningEntry[]; }

function atomicWriteJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value), "utf8");
  renameSync(tmp, file);
}

/** Rebuild and persist the index. Called after memory mutations; safe to ignore errors. */
export function refreshWarningIndex(config: Config): void {
  try {
    atomicWriteJson(indexPath(config), { version: 1, builtAt: new Date().toISOString(), entries: buildWarningIndex(config) } satisfies IndexFile);
  } catch { /* index is a cache — never break memory writes */ }
}

/** Entries for the hook: cached index when fresh, rebuild on miss/stale/corrupt. */
export function warningsForHook(config: Config): WarningEntry[] {
  const file = indexPath(config);
  try {
    if (existsSync(file) && Date.now() - statSync(file).mtimeMs < INDEX_TTL_MS) {
      const data = JSON.parse(readFileSync(file, "utf8")) as IndexFile;
      if (Array.isArray(data.entries)) return data.entries;
    }
  } catch { /* fall through to rebuild */ }
  const entries = buildWarningIndex(config);
  try { atomicWriteJson(file, { version: 1, builtAt: new Date().toISOString(), entries } satisfies IndexFile); } catch { /* read-only store is fine */ }
  return entries;
}

// ---------------------------------------------------------------- session state

export interface SessionState { ctx: string[]; blk: string[]; updatedAt: string; }
interface StateFile { sessions: Record<string, SessionState>; }

export function statePath(config: Config): string {
  return join(dirname(config.memoryDir), "hook-state.json");
}

export function loadHookState(config: Config): StateFile {
  try {
    const data = JSON.parse(readFileSync(statePath(config), "utf8")) as StateFile;
    if (data && typeof data === "object" && data.sessions) return data;
  } catch { /* missing/corrupt → fresh */ }
  return { sessions: {} };
}

/** Drop sessions older than STATE_TTL_MS and cap the file size. */
export function pruneState(state: StateFile): StateFile {
  const cutoff = Date.now() - STATE_TTL_MS;
  const sessions = Object.fromEntries(
    Object.entries(state.sessions).filter(([, s]) => Date.parse(s.updatedAt) > cutoff),
  );
  const keys = Object.keys(sessions);
  if (keys.length > MAX_SESSIONS) {
    keys.sort((a, b) => Date.parse(sessions[a].updatedAt) - Date.parse(sessions[b].updatedAt));
    for (const key of keys.slice(0, keys.length - MAX_SESSIONS)) delete sessions[key];
  }
  return { sessions };
}

export function saveHookState(config: Config, state: StateFile): void {
  try { atomicWriteJson(statePath(config), pruneState(state)); } catch { /* dedupe is best-effort */ }
}

export function sessionOf(state: StateFile, sessionId: string): SessionState {
  return state.sessions[sessionId] ??= { ctx: [], blk: [], updatedAt: new Date().toISOString() };
}

// ---------------------------------------------------------------- formatting

export function formatWarnings(entries: WarningEntry[]): string {
  const lines = entries.map((e) => `- [${e.status}] ${e.title || e.path} — memory_read("${e.path}")`);
  return `remme: ${entries.length} recorded ${entries.length === 1 ? "memory may apply" : "memories may apply"}:\n${lines.join("\n")}`;
}

export function formatBlockReason(entries: WarningEntry[]): string {
  return `${formatWarnings(entries)}\nThis action matches a recorded pitfall. Read the memory first; retrying the same call is allowed and will not be blocked again this session.`;
}
