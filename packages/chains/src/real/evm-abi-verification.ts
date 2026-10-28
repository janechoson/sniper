import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { evmSourceAbis } from "./evm-source-abis";

export function verifyEvmDiscoveryAbis() {
  const manifest = z
    .object({
      version: z.literal(1),
      profiles: z.array(
        z.object({
          family: z.string(),
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
          references: z.array(z.string().url()).min(1),
        }),
      ),
    })
    .parse(
      JSON.parse(
        readFileSync(
          new URL("../../abi/evm-discovery-manifest.json", import.meta.url),
          "utf8",
        ),
      ),
    );
  if (manifest.profiles.length !== Object.keys(evmSourceAbis).length)
    throw new Error("DISCOVERY_ABI_MANIFEST_INCOMPLETE");
  for (const profile of manifest.profiles) {
    const abi = evmSourceAbis[profile.family];
    if (
      !abi ||
      createHash("sha256").update(JSON.stringify(abi)).digest("hex") !==
        profile.sha256
    )
      throw new Error("DISCOVERY_ABI_CHECKSUM_MISMATCH");
  }
  return { verified: true, profiles: manifest.profiles.length };
}
