// Four public, pinned immutable files only. Never reads credentials or BOT state.
import { readFileSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(
  readFileSync(join(root, "lab/kronos/model-files.json"), "utf8"),
);
for (const f of manifest.files) {
  const target = join(root, "runtime", f.group, f.name);
  const hash = (b) => createHash("sha256").update(b).digest("hex");
  if (existsSync(target) && hash(readFileSync(target)) === f.sha256) continue;
  const response = await fetch(
    `https://huggingface.co/${f.id}/resolve/${f.revision}/${f.name}`,
    { signal: AbortSignal.timeout(180000) },
  );
  if (!response.ok) throw Error("PINNED_MODEL_DOWNLOAD_FAILED");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length !== f.bytes || hash(bytes) !== f.sha256)
    throw Error("PINNED_MODEL_HASH_MISMATCH");
  mkdirSync(join(root, "runtime", f.group), { recursive: true });
  writeFileSync(target, bytes);
}
console.log(
  "Pinned Kronos model/tokenizer verified; no trade data or credentials used.",
);
