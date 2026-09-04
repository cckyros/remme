import { build } from "esbuild";
await build({ entryPoints: ["src/cli.ts"], outfile: "dist/cli.js", bundle: true, platform: "node", format: "esm", target: "node18", external: ["@huggingface/transformers", "better-sqlite3", "sqlite-vec"] });
