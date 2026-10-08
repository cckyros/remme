// Single source of identity for remme. build.mjs generates plugin.json, mcp.json,
// .mcp.json and skills/remme/SKILL.md from this object; the installer reads the
// same markers to find and remove only the files it wrote.
// `name` is the local package id, NOT an npm install target: the npm registry
// entry named "remme" belongs to an unrelated project, so every generated
// MCP entry points at the absolute node + dist/cli.js path instead.
export interface PluginManifest {
  name: string;
  version: string;
  brand: string;
  description: string;
  githubSlug: string;
  markers: {
    skill: string;
    skillDir: string;
    configDir: string;
    cursorDir: string;
    cursorMarkerFile: string;
    cursorMarker: string;
    agentsStart: string;
    agentsEnd: string;
  };
}

export const manifest: PluginManifest = {
  name: "remme",
  version: "0.1.0",
  brand: "remme",
  description: "Local-first MCP knowledge memory with SQLite and cross-agent provenance.",
  githubSlug: "cckyros/remme",
  markers: {
    skill: "remme:skill",
    skillDir: "remme",
    configDir: ".remme",
    cursorDir: "remme",
    cursorMarkerFile: ".remme-managed",
    cursorMarker: "remme:managed",
    agentsStart: "<!-- remme:start -->",
    agentsEnd: "<!-- remme:end -->",
  },
};
