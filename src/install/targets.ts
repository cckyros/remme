// Install targets: 22 agents in three kinds, the same grouping as
// goal-acceptance. native = writes the agent's MCP config (and skill);
// skill = copies the skill and gives MCP guidance; plugin = materializes the
// Agent Plugins package (~/.remme/plugin) and registers it with the client.
// A target never throws: missing CLIs or unparseable configs come back as
// "manual" with the exact steps, so one client never blocks the others.
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import memoryRules from "../assets/agents-fragment.md";
import { manifest } from "../plugin/manifest.ts";
import {
  claudeEntry, cliPath, combine, dropJson, error, hasCli, installSkill, localEntry, manual, materialize,
  ok, pluginReady, read, removeBlock, runCli, setJson, skipped, stdioEntry, uninstallSkill, upsertBlock, write,
} from "./shared.ts";
import type { Ctx, Kind, Result } from "./shared.ts";

export interface Target {
  id: string;
  kind: Kind;
  label: string;
  scope: "project" | "global" | "both";
  install: (ctx: Ctx) => Result;
  uninstall: (ctx: Ctx) => Result;
}

const { name, brand, markers } = manifest;
const win = process.platform === "win32";
const TOML_START = "# remme:start";
const TOML_END = "# remme:end";
const KEEP_SHARED = `shared .agents/skills/${markers.skillDir} kept (other agents may use it) — delete it by hand if unwanted`;
const mcpFileNote = `project .mcp.json is shared with other agents — our entry was removed`;

/** Project-relative path for project-only targets. */
const proj = (c: Ctx, ...p: string[]) => join(c.dir, ...p);
/** Scope-relative path: project dir for project scope, home for global. */
const at = (c: Ctx, ...p: string[]) => join(c.scope === "global" ? c.home : c.dir, ...p);
const appDir = (home: string, app: string) => (win ? join(home, "AppData", "Roaming", app) : join(home, ".config", app));
const reasonixHome = (home: string) => (win ? join(home, "AppData", "Roaming", "reasonix") : join(home, ".reasonix"));
const sharedSkill = (c: Ctx) => at(c, ".agents", "skills", markers.skillDir);
const skillAt = (c: Ctx, ...p: string[]) => at(c, ...p, "skills", markers.skillDir);
const tomlCommand = () => `command = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(cliPath)}, "mcp"]`;

/** Native target whose MCP entry is one JSON key. `keepSkill` = skill is shared. */
function mcpJson(o: {
  id: string; label: string; scope: Target["scope"]; file: (c: Ctx) => string; key: string;
  entry: () => Record<string, unknown>; skill: (c: Ctx) => string; keepSkill?: boolean;
}): Target {
  const path = [o.key, name];
  return {
    id: o.id, kind: "native", label: o.label, scope: o.scope,
    install: (c) => combine([setJson(o.file(c), path, o.entry(), c.dryRun), installSkill(o.skill(c), c.dryRun)]),
    uninstall: (c) => combine([
      dropJson(o.file(c), path, c.dryRun),
      o.keepSkill ? ok(KEEP_SHARED) : uninstallSkill(o.skill(c), c.dryRun),
    ]),
  };
}

// ---------------------------------------------------------------- native

const claude = mcpJson({
  id: "claude", label: "Claude Code", scope: "both",
  file: (c) => at(c, ".claude", "settings.json"), key: "mcpServers", entry: claudeEntry,
  skill: (c) => skillAt(c, ".claude"),
});

const qwen = mcpJson({
  id: "qwen", label: "Qwen Code", scope: "both",
  file: (c) => at(c, ".qwen", "settings.json"), key: "mcpServers", entry: claudeEntry,
  skill: (c) => skillAt(c, ".qwen"),
});

const workbuddy = mcpJson({
  id: "workbuddy", label: "WorkBuddy", scope: "both",
  file: (c) => (c.scope === "global" ? join(c.home, ".codebuddy", ".mcp.json") : proj(c, ".mcp.json")),
  key: "mcpServers", entry: stdioEntry, skill: (c) => skillAt(c, ".codebuddy"),
});

const devin = mcpJson({
  id: "devin", label: "Devin", scope: "both",
  file: (c) => (c.scope === "global" ? join(appDir(c.home, "devin"), "mcp_config.json") : proj(c, ".devin", "mcp_config.json")),
  key: "mcpServers", entry: claudeEntry, skill: sharedSkill, keepSkill: true,
});

const opencode = mcpJson({
  id: "opencode", label: "OpenCode", scope: "both",
  file: (c) => (c.scope === "global" ? join(appDir(c.home, "opencode"), "opencode.json") : proj(c, "opencode.json")),
  key: "mcp", entry: localEntry, skill: sharedSkill, keepSkill: true,
});

const kilo = mcpJson({
  id: "kilo", label: "Kilo Code", scope: "both",
  file: (c) => (c.scope === "global" ? join(c.home, ".config", "kilo", "kilo.json") : proj(c, ".kilo", "kilo.json")),
  key: "mcp", entry: localEntry, skill: sharedSkill, keepSkill: true,
});

const codex: Target = {
  id: "codex", kind: "native", label: "Codex", scope: "both",
  install(c) {
    const toml = join(at(c, ".codex"), "config.toml");
    const raw = read(toml) ?? "";
    const conflict = raw.includes(`[mcp_servers."${name}"]`) && !raw.includes(TOML_START);
    const block = `[mcp_servers."${name}"]\n${tomlCommand()}\ntool_timeout_sec = 180`;
    const agents = c.scope === "global" ? join(c.home, ".codex", "AGENTS.md") : proj(c, "AGENTS.md");
    return combine([
      conflict
        ? manual(`${toml} already defines [mcp_servers."${name}"] outside our block — left untouched; remove it and re-run`)
        : upsertBlock(toml, TOML_START, TOML_END, block, c.dryRun),
      upsertBlock(agents, markers.agentsStart, markers.agentsEnd, memoryRules, c.dryRun),
      c.scope === "project" ? installSkill(sharedSkill(c), c.dryRun) : ok("shared .agents/skills is project-level for Codex (global skipped)"),
      fixCodexModels(c),
    ]);
  },
  uninstall(c) {
    const toml = join(at(c, ".codex"), "config.toml");
    const agents = c.scope === "global" ? join(c.home, ".codex", "AGENTS.md") : proj(c, "AGENTS.md");
    return combine([
      removeBlock(toml, TOML_START, TOML_END, c.dryRun),
      removeBlock(agents, markers.agentsStart, markers.agentsEnd, c.dryRun),
      ok(KEEP_SHARED),
    ]);
  },
};

/** Codex hides every mcp__* tool for models flagged supports_search_tool (openai/codex#36382). */
function fixCodexModels(c: Ctx): Result {
  const file = [proj(c, ".codex", "models.json"), join(c.home, ".codex", "models.json")].find(existsSync);
  if (!file) return ok("models.json not found (nothing to fix)");
  let data: any;
  try { data = JSON.parse(read(file)!); } catch { return manual(`${file} is not valid JSON — check supports_search_tool by hand`); }
  const models: any[] = Array.isArray(data) ? data : Array.isArray(data?.models) ? data.models : [];
  const flipped = models.filter((m) => m?.supports_search_tool === true);
  if (!flipped.length) return ok(`${file}: no supports_search_tool=true entries`);
  for (const m of flipped) m.supports_search_tool = false;
  return ok(`${file}: set supports_search_tool=false on ${flipped.length} model(s) ${write(file, JSON.stringify(data, null, 2) + "\n", c.dryRun)}`);
}

const reasonix: Target = {
  id: "reasonix", kind: "native", label: "Reasonix", scope: "both",
  install(c) {
    const skill = installSkill(sharedSkill(c), c.dryRun);
    if (c.scope === "project") return combine([skill, setJson(proj(c, ".mcp.json"), ["mcpServers", name], stdioEntry(), c.dryRun)]);
    const toml = join(reasonixHome(c.home), "config.toml");
    const block = `[[plugins]]\nname = ${JSON.stringify(name)}\ntype = "stdio"\n${tomlCommand()}`;
    return combine([skill, upsertBlock(toml, TOML_START, TOML_END, block, c.dryRun)]);
  },
  uninstall(c) {
    if (c.scope === "project") return combine([dropJson(proj(c, ".mcp.json"), ["mcpServers", name], c.dryRun), ok(mcpFileNote), ok(KEEP_SHARED)]);
    return combine([removeBlock(join(reasonixHome(c.home), "config.toml"), TOML_START, TOML_END, c.dryRun), ok(KEEP_SHARED)]);
  },
};

// ---------------------------------------------------------------- skill

/** Skill-copy targets: project-level skill plus guidance (no native plugin). */
function skillTarget(o: { id: string; label: string; dir: (c: Ctx) => string; guidance: string }): Target {
  return {
    id: o.id, kind: "skill", label: o.label, scope: "project",
    install: (c) => combine([installSkill(o.dir(c), c.dryRun), manual(o.guidance)]),
    uninstall: (c) => combine([uninstallSkill(o.dir(c), c.dryRun), ok(KEEP_SHARED)]),
  };
}

const trae = skillTarget({
  id: "trae", label: "Trae", dir: (c) => proj(c, ".trae", "skills", markers.skillDir),
  guidance: `Trae is an IDE: import .trae/skills/${markers.skillDir} in Settings → Rules & Skills, then add the MCP server manually (command: ${process.execPath}, args: ${cliPath} mcp)`,
});

const omp = skillTarget({
  id: "omp", label: "Oh My Pi", dir: sharedSkill,
  guidance: `MCP not automated: register the server in omp's MCP settings (command: ${process.execPath}, args: ${cliPath} mcp)`,
});

const dsh = skillTarget({
  id: "dsh", label: "dsh", dir: sharedSkill,
  guidance: `MCP not automated: add the server to your dsh MCP config (command: ${process.execPath}, args: ${cliPath} mcp)`,
});

const pi: Target = {
  id: "pi", kind: "skill", label: "pi", scope: "project",
  install(c) {
    const skill = installSkill(sharedSkill(c), c.dryRun);
    const mcpFile = join(c.home, ".pi", "agent", "mcp.json");
    const adapter = existsSync(mcpFile) || existsSync(join(c.home, ".pi", "agent", "npm"));
    if (!adapter) return combine([skill, manual("MCP not configured: install an MCP adapter extension for pi, restart pi, then re-run install --target pi")]);
    return combine([skill, setJson(mcpFile, ["mcpServers", name], claudeEntry(), c.dryRun)]);
  },
  uninstall: (c) => combine([dropJson(join(c.home, ".pi", "agent", "mcp.json"), ["mcpServers", name], c.dryRun), ok(KEEP_SHARED)]),
};

// ---------------------------------------------------------------- plugin

/** Client with a documented CLI: run its plugin install against the materialized
 *  dir when the CLI exists, otherwise return manual steps. */
function cliPlugin(o: {
  id: string; label: string; bin: string; args: (dir: string) => string[];
  remove?: string[]; manual: string;
}): Target {
  return {
    id: o.id, kind: "plugin", label: o.label, scope: "global",
    install(c) {
      const missing = pluginReady();
      if (missing) return missing;
      const dir = materialize(c.home, c.dryRun);
      if (!hasCli(o.bin)) return manual(`${o.bin} CLI not found. ${o.manual} Plugin dir: ${dir}`);
      if (c.dryRun) return ok(`[dry-run] would run: ${o.bin} ${o.args(dir).join(" ")}`);
      const r = runCli(o.bin, o.args(dir));
      return r.code === 0 ? ok(`installed via ${o.bin} from ${dir}`) : error(`${o.bin} install failed: ${r.out}`);
    },
    uninstall(c) {
      if (!o.remove || !hasCli(o.bin)) return manual(`${o.manual} To remove: uninstall ${name} in ${o.label}.`);
      if (c.dryRun) return ok(`[dry-run] would run: ${o.bin} ${o.remove.join(" ")}`);
      const r = runCli(o.bin, o.remove);
      return r.code === 0 ? ok(`removed via ${o.bin}`) : error(`${o.bin} uninstall failed: ${r.out}`);
    },
  };
}

const copilot = cliPlugin({
  id: "copilot", label: "GitHub Copilot", bin: "copilot",
  args: (dir) => ["plugin", "install", dir], remove: ["plugin", "uninstall", name],
  manual: "Install the CLI with npm i -g @github/copilot, then run: copilot plugin install <plugin dir>.",
});

const hermes = cliPlugin({
  id: "hermes", label: "Hermes", bin: "hermes",
  args: (dir) => ["plugin", "install", dir],
  manual: "Install Hermes, then run: hermes plugin install <plugin dir>.",
});

const grok = cliPlugin({
  id: "grok", label: "Grok Bot", bin: "grok",
  args: (dir) => ["plugin", "install", dir, "--trust"], remove: ["plugin", "uninstall", name, "--confirm"],
  manual: "Or copy the plugin dir to ~/.grok/plugins/remme and start a new session.",
});

const cursor: Target = {
  id: "cursor", kind: "plugin", label: "Cursor", scope: "global",
  install(c) {
    const missing = pluginReady();
    if (missing) return missing;
    const dest = join(c.home, ".cursor", "plugins", "local", markers.cursorDir);
    if (!existsSync(join(c.home, ".cursor"))) return manual(`Cursor not detected (~/.cursor missing). Copy ${materialize(c.home, true)} to ${dest} by hand.`);
    if (c.dryRun) return ok(`[dry-run] would copy the plugin dir to ${dest}`);
    const dir = materialize(c.home, false);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(dir, dest, { recursive: true, force: true });
    write(join(dest, markers.cursorMarkerFile), `${markers.cursorMarker}\n`, false);
    return ok(`copied plugin to ${dest} — run "Developer: Reload Window" in Cursor`);
  },
  uninstall(c) {
    const dest = join(c.home, ".cursor", "plugins", "local", markers.cursorDir);
    if (!existsSync(dest)) return ok(`not present: ${dest}`);
    if (!existsSync(join(dest, markers.cursorMarkerFile))) return skipped(`${dest} has no marker — user-authored, kept`);
    if (!c.dryRun) rmSync(dest, { recursive: true, force: true });
    return ok(`${c.dryRun ? "would remove" : "removed"} ${dest}`);
  },
};

const vscode: Target = {
  id: "vscode", kind: "plugin", label: "VS Code", scope: "global",
  install(c) {
    const missing = pluginReady();
    if (missing) return missing;
    const dir = materialize(c.home, c.dryRun);
    const settings = join(appDir(c.home, "Code"), "User", "settings.json");
    if (!existsSync(dirname(settings))) return manual(`VS Code user settings not found. Add "chat.pluginLocations": { "${dir}": true } to your settings.`);
    return setJson(settings, ["chat", "pluginLocations", dir], true, c.dryRun);
  },
  uninstall(c) {
    const dir = materialize(c.home, true);
    return dropJson(join(appDir(c.home, "Code"), "User", "settings.json"), ["chat", "pluginLocations", dir], c.dryRun);
  },
};

const chatgptCodex: Target = {
  id: "chatgpt-codex", kind: "plugin", label: "ChatGPT & Codex", scope: "global",
  install(c) {
    const missing = pluginReady();
    if (missing) return missing;
    const dir = materialize(c.home, c.dryRun);
    const shim = join(c.home, markers.configDir, "marketplace");
    if (!c.dryRun) writeShim(shim, dir);
    if (!hasCli("codex")) return manual(`codex CLI not found. Marketplace shim written to ${shim}: add it as a local marketplace in ChatGPT/Codex and install "${name}".`);
    if (c.dryRun) return ok(`[dry-run] would write the marketplace shim and run codex plugin marketplace add ${shim}`);
    const added = runCli("codex", ["plugin", "marketplace", "add", shim]);
    if (added.code !== 0) return error(`codex plugin marketplace add failed: ${added.out}`);
    const plugin = runCli("codex", ["plugin", "add", `${name}@${name}`]);
    return plugin.code === 0 ? ok(`installed via codex (marketplace ${shim})`) : error(`codex plugin add failed: ${plugin.out}`);
  },
  uninstall(c) {
    if (!hasCli("codex")) return manual(`Remove "${name}" in the ChatGPT/Codex plugins UI.`);
    if (c.dryRun) return ok(`[dry-run] would run codex plugin remove ${name}@${name}`);
    const r = runCli("codex", ["plugin", "remove", `${name}@${name}`]);
    return r.code === 0 ? ok("removed via codex") : error(`codex plugin remove failed: ${r.out}`);
  },
};

function writeShim(shim: string, dir: string): void {
  const manifestFile = join(shim, ".agents", "plugins", "marketplace.json");
  mkdirSync(dirname(manifestFile), { recursive: true });
  cpSync(dir, join(shim, "plugin"), { recursive: true, force: true });
  write(manifestFile, JSON.stringify({
    name, owner: { name: manifest.githubSlug.split("/")[0] },
    plugins: [{ name, source: { source: "local", path: "./plugin" }, policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" }, category: "development" }],
  }, null, 2) + "\n", false);
}

const nanoclaw: Target = {
  id: "nanoclaw", kind: "plugin", label: "NanoClaw", scope: "global",
  install(c) {
    const missing = pluginReady();
    if (missing) return missing;
    const dir = materialize(c.home, c.dryRun);
    const templates = process.env.NANOCLAW_TEMPLATES_DIR ?? join(c.home, markers.configDir, "nanoclaw-templates");
    const dest = join(templates, name);
    if (!hasCli("ncl")) return manual(`ncl CLI not found. Copy ${dir} to ${dest} (NanoClaw rejects symlinks) and stamp it with: ncl groups create --template ${name} --name "${brand}"`);
    if (c.dryRun) return ok(`[dry-run] would copy the plugin to ${dest} and stamp it with ncl`);
    mkdirSync(templates, { recursive: true });
    cpSync(dir, dest, { recursive: true, force: true });
    process.env.NANOCLAW_TEMPLATES_DIR ??= templates;
    const r = runCli("ncl", ["groups", "create", "--template", name, "--name", brand]);
    return r.code === 0 ? ok(`stamped ${dest} via ncl (tasks start paused)`) : error(`ncl groups create failed: ${r.out}`);
  },
  uninstall: () => manual("NanoClaw has no plugin uninstall: delete the stamped group in the NanoClaw app."),
};

const kiro: Target = {
  id: "kiro", kind: "plugin", label: "Kiro", scope: "global",
  install(c) {
    const missing = pluginReady();
    if (missing) return missing;
    return manual(`Kiro has no CLI. Powers panel → Add Custom Power → Import power from a folder → ${materialize(c.home, c.dryRun)}`);
  },
  uninstall: () => manual("Kiro: remove the power in the Powers panel."),
};

const openclaw: Target = {
  id: "openclaw", kind: "plugin", label: "OpenClaw", scope: "global",
  install(c) {
    const missing = pluginReady();
    if (missing) return missing;
    return manual(`No native OpenClaw bundle is shipped yet. Plugin dir: ${materialize(c.home, c.dryRun)}; MCP entry: node ${cliPath} mcp`);
  },
  uninstall: () => manual("OpenClaw: remove the MCP server from your OpenClaw config."),
};

const other: Target = {
  id: "other", kind: "plugin", label: "Other agents (Agent Plugins standard)", scope: "global",
  install(c) {
    const missing = pluginReady();
    if (missing) return missing;
    return manual(`Install the plugin directory ${materialize(c.home, c.dryRun)} in your agent per its plugin docs (agent-plugins.org/specification).`);
  },
  uninstall: (c) => manual(`Uninstall the plugin in your agent; the plugin dir ${join(c.home, markers.configDir, "plugin")} is kept.`),
};

export const targets: Target[] = [
  claude, codex, opencode, qwen, reasonix, kilo, workbuddy, devin,
  trae, pi, omp, dsh,
  copilot, cursor, kiro, openclaw, hermes, vscode, chatgptCodex, grok, nanoclaw, other,
];
