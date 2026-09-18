import { spawnSync } from "node:child_process";
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

// Validate every workspace package the way npm will see it: publint checks the
// manifest/exports, attw checks the generated type declarations across ESM/CJS.
const bin = (name) => join("node_modules", ".bin", name);

const packages = readdirSync("packages", { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

let failed = false;

for (const name of packages) {
  const dir = join("packages", name);
  console.log(`\n=== ${name} ===`);

  if (spawnSync(bin("publint"), [dir, "--strict"], { stdio: "inherit" }).status !== 0) {
    failed = true;
  }

  const pack = spawnSync("bun", ["pm", "pack"], { cwd: dir, encoding: "utf8" });
  if (pack.status !== 0) {
    console.error(pack.stderr || `bun pm pack failed for ${name}`);
    failed = true;
    continue;
  }

  const tarball = readdirSync(dir).find((file) => file.endsWith(".tgz"));
  if (!tarball) {
    console.error(`no tarball produced for ${name}`);
    failed = true;
    continue;
  }

  const path = join(dir, tarball);
  if (spawnSync(bin("attw"), [path], { stdio: "inherit" }).status !== 0) {
    failed = true;
  }
  rmSync(path, { force: true });
}

if (failed) {
  console.error("\npackage checks failed");
  process.exit(1);
}
console.log("\npackage checks passed");
