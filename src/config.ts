import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface Config {
  dbPath: string;
  memoryDir: string;
  embeddingModel: string;
  vectorWeight: number;
  textWeight: number;
  maxResults: number;
  minScore: number;
  mmrEnabled: boolean;
  agent: string;
}

const defaults: Config = {
  dbPath: join(homedir(), ".remme", "memory.db"),
  memoryDir: join(homedir(), ".remme", "memory"),
  embeddingModel: "Xenova/all-MiniLM-L6-v2",
  vectorWeight: 0.7,
  textWeight: 0.3,
  maxResults: 6,
  minScore: 0,
  mmrEnabled: true,
  agent: process.env.REMME_AGENT ?? "unknown",
};

export function loadConfig(cwd = process.cwd()): Config {
  const path = process.env.REMME_CONFIG ?? join(homedir(), ".remme", "config.json");
  let file: Partial<Config> = {};
  if (existsSync(path)) {
    try { file = JSON.parse(readFileSync(path, "utf8")) as Partial<Config>; } catch { /* defaults */ }
  }
  const value = { ...defaults, ...file };
  return {
    ...value,
    dbPath: resolve(value.dbPath),
    memoryDir: resolve(value.memoryDir),
    agent: process.env.REMME_AGENT ?? value.agent,
  };
}

export function ensureConfigDirs(config: Config): void {
  mkdirSync(config.memoryDir, { recursive: true });
  mkdirSync(join(config.dbPath, ".."), { recursive: true });
}
