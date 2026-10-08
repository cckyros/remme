// Build script: bundles the CLI, then generates the identity files and the
// packaged skill from src/plugin/manifest.ts (single source of identity).
// Generated files are committed so the repo is a valid plugin source.
import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));

async function loadManifest() {
  const result = await build({
    entryPoints: [join(root, "src/plugin/manifest.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
    logLevel: "silent",
  });
  const code = Buffer.from(result.outputFiles[0].text).toString("base64");
  return (await import(`data:text/javascript;base64,${code}`)).manifest;
}

const manifest = await loadManifest();
const { name, brand, version, description, githubSlug, markers } = manifest;

await build({
  entryPoints: [join(root, "src/cli.ts")],
  outfile: join(root, "dist/cli.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  external: ["@huggingface/transformers", "better-sqlite3", "sqlite-vec"],
  loader: { ".md": "text" },
  logLevel: "info",
});

const fill = (body, vars) => body.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => vars[key] ?? `{{${key}}}`);
const rules = (await readFile(join(root, "src/assets/agents-fragment.md"), "utf8")).trim();
const skill = fill(await readFile(join(root, "src/assets/SKILL.md"), "utf8"), { name, brand, description, memoryRules: rules });
await mkdir(join(root, "skills", markers.skillDir), { recursive: true });
await writeFile(join(root, "skills", markers.skillDir, "SKILL.md"), skill, "utf8");

const homepage = `https://github.com/${githubSlug}`;
const json = (value) => JSON.stringify(value, null, 2) + "\n";
// Relative command: the installer rewrites this in the materialized plugin dir
// with the absolute node + dist/cli.js path. No npm package name is used here.
const mcp = {
  $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
  mcpServers: { [name]: { type: "stdio", command: "node", args: ["dist/cli.js", "mcp"] } },
};
await writeFile(join(root, "plugin.json"), json({
  $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  name: brand,
  version,
  description,
  author: { name: githubSlug.split("/")[0] },
  homepage,
  repository: homepage,
  keywords: [name, "mcp", "agent-plugins", "agent-skills", "memory"],
}), "utf8");
await writeFile(join(root, "mcp.json"), json(mcp), "utf8");
await writeFile(join(root, ".mcp.json"), json(mcp), "utf8");

console.log(`build ok: dist/cli.js + skills/${markers.skillDir}/SKILL.md + plugin.json + mcp.json (${name} v${version})`);
