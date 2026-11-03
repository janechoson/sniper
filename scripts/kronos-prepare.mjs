// Public downloads only; never load BOT config, .env or credential libraries.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
const root = resolve(
  process.argv[2] ||
    join(process.env.LOCALAPPDATA || ".", "gmgn-kronos-runtime"),
);
if (root.toLowerCase().startsWith(resolve(".").toLowerCase()))
  throw Error("Runtime must be outside BOT workspace");
const pins = JSON.parse(readFileSync("lab/kronos/pins.json", "utf8"));
mkdirSync(root, { recursive: true });
const manifest = { commit: pins.commit, files: [] };
for (const group of ["model", "tokenizer"]) {
  const { id, revision } = pins[group];
  const metadata = await fetch(
    `https://huggingface.co/api/models/${id}/revision/${revision}?blobs=true`,
    { signal: AbortSignal.timeout(30000) },
  );
  if (!metadata.ok) throw Error("MODEL_METADATA_UNAVAILABLE");
  const info = await metadata.json();
  if (info.sha !== revision) throw Error("MODEL_REVISION_MISMATCH");
  mkdirSync(join(root, group), { recursive: true });
  for (const name of ["config.json", "model.safetensors"]) {
    const row = info.siblings.find((x) => x.rfilename === name);
    const target = join(root, group, name);
    let data = existsSync(target) ? readFileSync(target) : null;
    if (!data) {
      const response = await fetch(
        `https://huggingface.co/${id}/resolve/${revision}/${name}`,
        { signal: AbortSignal.timeout(180000) },
      );
      if (!response.ok) throw Error("MODEL_DOWNLOAD_FAILED");
      data = Buffer.from(await response.arrayBuffer());
      if (data.length > 256 * 1024 * 1024) throw Error("MODEL_TOO_LARGE");
    }
    const sha256 = createHash("sha256").update(data).digest("hex");
    if (row?.lfs?.sha256 && sha256 !== row.lfs.sha256)
      throw Error("MODEL_HASH_MISMATCH");
    if (!row?.lfs?.sha256 && name !== "config.json")
      throw Error("MODEL_HASH_NOT_ESTABLISHED");
    writeFileSync(target, data);
    manifest.files.push({
      group,
      id,
      revision,
      name,
      sha256,
      bytes: data.length,
    });
  }
}
writeFileSync(join(root, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify(manifest, null, 2));
