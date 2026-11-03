import { rmSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, dirname, basename } from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
const args = process.argv.slice(2);
const outputName =
  args.length === 0
    ? "dist"
    : args.length === 2 &&
        args[0] === "--out-dir" &&
        /^\.build-[a-z0-9-]+$/.test(args[1])
      ? args[1]
      : undefined;
if (!outputName)
  throw Error("Use --out-dir .build-<name> for an isolated build");
const root = resolve("."),
  output = resolve(root, outputName);
if (dirname(output) !== root || basename(output) !== outputName)
  throw Error("Build output escaped project root");
rmSync(output, { recursive: true, force: true });
execFileSync(
  process.execPath,
  [
    createRequire(import.meta.url).resolve("typescript/bin/tsc"),
    "-p",
    "tsconfig.build.json",
    "--outDir",
    output,
  ],
  { stdio: "inherit", windowsHide: true },
);
const digest = createHash("sha256");
for (const directory of ["src", "public", "config"])
  for (const name of readdirSync(resolve(root, directory)).sort()) {
    if (/\.(ts|js|html|css|json)$/.test(name))
      digest
        .update(directory + "/" + name)
        .update(readFileSync(resolve(root, directory, name)));
  }
writeFileSync(
  resolve(output, "build-info.json"),
  JSON.stringify({
    id: digest.digest("hex"),
    builtAt: new Date().toISOString(),
  }),
);
