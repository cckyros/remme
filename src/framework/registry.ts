import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type TargetResult = { status: "ok" | "manual" | "error"; detail: string };
export type InstallContext = { home: string; cwd: string; dryRun: boolean };
export interface TargetAdapter { id: string; label: string; detect(ctx: InstallContext): boolean; install(ctx: InstallContext): TargetResult; uninstall(ctx: InstallContext): TargetResult; }

function mergeMcp(file: string, ctx: InstallContext): TargetResult {
  const data = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  const servers = (data.mcpServers ??= {});
  servers.remme = { command: "npx", args: ["-y", "remme", "mcp"] };
  if (!ctx.dryRun) { mkdirSync(join(file, ".."), { recursive: true }); if (existsSync(file)) copyFileSync(file, `${file}.bak`); writeFileSync(file, JSON.stringify(data, null, 2) + "\n", "utf8"); }
  return { status: "ok", detail: `${ctx.dryRun ? "would write" : "wrote"} ${file}` };
}

export const adapters: TargetAdapter[] = [
  { id: "claude", label: "Claude Code", detect: () => true, install: (ctx) => mergeMcp(join(ctx.home, ".claude", "settings.json"), ctx), uninstall: (ctx) => removeMcp(join(ctx.home, ".claude", "settings.json"), ctx) },
  { id: "cursor", label: "Cursor", detect: (ctx) => existsSync(join(ctx.home, ".cursor")), install: (ctx) => mergeMcp(join(ctx.home, ".cursor", "mcp.json"), ctx), uninstall: (ctx) => removeMcp(join(ctx.home, ".cursor", "mcp.json"), ctx) },
  { id: "codex", label: "Codex", detect: () => true, install: (ctx) => ({ status: "manual", detail: "Add [mcp_servers.remme] with command=npx and args=[\"-y\", \"remme\", \"mcp\"] to ~/.codex/config.toml" }), uninstall: () => ({ status: "manual", detail: "Remove the remme section from ~/.codex/config.toml" }) },
  { id: "openclaw", label: "OpenClaw", detect: (ctx) => existsSync(join(ctx.home, ".openclaw")), install: (ctx) => mergeMcp(join(ctx.home, ".openclaw", "mcp.json"), ctx), uninstall: (ctx) => removeMcp(join(ctx.home, ".openclaw", "mcp.json"), ctx) },
  { id: "devin", label: "Devin", detect: () => true, install: (ctx) => mergeMcp(join(ctx.home, "AppData", "Roaming", "devin", "mcp_config.json"), ctx), uninstall: (ctx) => removeMcp(join(ctx.home, "AppData", "Roaming", "devin", "mcp_config.json"), ctx) },
];

function removeMcp(file: string, ctx: InstallContext): TargetResult { if (!existsSync(file)) return { status: "ok", detail: `nothing to remove in ${file}` }; const data = JSON.parse(readFileSync(file, "utf8")); if (data.mcpServers?.remme) delete data.mcpServers.remme; if (!ctx.dryRun) writeFileSync(file, JSON.stringify(data, null, 2) + "\n", "utf8"); return { status: "ok", detail: `${ctx.dryRun ? "would remove" : "removed"} remme from ${file}` }; }
