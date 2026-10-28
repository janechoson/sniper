import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const manifest = JSON.parse(
  await readFile("packages/chains/idl/manifest.json", "utf8"),
);
for (const item of manifest.sources) {
  const bytes = await readFile(`packages/chains/idl/${item.file}`);
  if (
    createHash("sha256").update(bytes).digest("hex") !== item.sha256 ||
    JSON.parse(bytes.toString("utf8")).address !== item.programId
  )
    throw new Error("IDL đã thay đổi: " + item.file);
}
process.stdout.write("Checksum và program ID của các IDL đều khớp.\n");
