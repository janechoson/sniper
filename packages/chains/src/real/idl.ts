import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { Idl } from "@coral-xyz/anchor";
import { z } from "zod";
const cache = new Map<string, { idl: Idl; hash: string }>();
const manifestSchema = z.object({
  version: z.literal(1),
  sources: z.array(
    z.object({
      file: z.string(),
      programId: z.string(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
    }),
  ),
});
export type SolanaDexFamily =
  "raydium-cpmm" | "meteora-dlmm" | "pump-fun" | "pump-swap";
export function loadVerifiedIdl(family: SolanaDexFamily) {
  const old = cache.get(family);
  if (old) return old;
  const file = family + ".json";
  const manifest = manifestSchema.parse(
    JSON.parse(
      readFileSync(new URL("../../idl/manifest.json", import.meta.url), "utf8"),
    ),
  );
  const source = manifest.sources.find((item) => item.file === file);
  if (!source) throw new Error("IDL_MANIFEST_MISSING");
  const bytes = readFileSync(new URL(`../../idl/${file}`, import.meta.url));
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (hash !== source.sha256) throw new Error("IDL_CHECKSUM_MISMATCH");
  const parsed: unknown = JSON.parse(bytes.toString("utf8"));
  if (
    z
      .object({
        address: z.string(),
        instructions: z.array(z.unknown()),
        types: z.array(z.unknown()),
      })
      .parse(parsed).address !== source.programId
  )
    throw new Error("IDL_PROGRAM_MISMATCH");
  const value = { idl: parsed as Idl, hash };
  cache.set(family, value);
  return value;
}
