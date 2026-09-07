import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const testRoot = fileURLToPath(new URL("./", import.meta.url));
const repoRoot = resolve(testRoot, "..");

function collectTests(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...collectTests(full));
    else if (entry.isFile() && entry.name.endsWith(".test.ts")) files.push(full);
  }
  return files;
}

const home = mkdtempSync(join(tmpdir(), "remme-test-home-"));
const testFiles = collectTests(testRoot).map((f) => relative(repoRoot, f)).sort();
console.log(`Running ${testFiles.length} test files: ${testFiles.join(", ")}`);
try {
  const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...testFiles], {
    cwd: repoRoot,
    stdio: "inherit",
    env: { ...process.env, HOME: home, USERPROFILE: home, REMME_CONFIG: join(home, "config.json"), REMME_DISABLE_EMBEDDING: "1" },
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally { rmSync(home, { recursive: true, force: true }); }
