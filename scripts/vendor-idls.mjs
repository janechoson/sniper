import { writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
const sources = [
  {
    file: "pump-fun.json",
    repository: "pump-fun/pump-public-docs",
    commit: "639b87fb45c3adeffa6f7c4a1bf0cb85e392bf22",
    path: "idl/pump.json",
    programId: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
  },
  {
    file: "pump-swap.json",
    repository: "pump-fun/pump-public-docs",
    commit: "639b87fb45c3adeffa6f7c4a1bf0cb85e392bf22",
    path: "idl/pump_amm.json",
    programId: "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
  },
  {
    file: "raydium-cpmm.json",
    repository: "raydium-io/raydium-idl",
    commit: "e7e0c96fe77bcf6a020b84a44c47a722aac8e359",
    path: "raydium_cpmm/raydium_cp_swap.json",
    programId: "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C",
  },
  {
    file: "meteora-dlmm.json",
    repository: "MeteoraAg/dlmm-sdk",
    commit: "2f540c2107988e0f97efa5917100bb912c96c17a",
    path: "idls/dlmm.json",
    programId: "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
  },
];
await mkdir("packages/chains/idl", { recursive: true });
const results = [];
for (const source of sources) {
  const url = `https://raw.githubusercontent.com/${source.repository}/${source.commit}/${source.path}`;
  const response = await fetch(url, {
    signal: AbortSignal.timeout(15000),
    redirect: "error",
  });
  if (!response.ok) throw new Error("Không tải được IDL đã ghim");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (
    bytes.length > 3_000_000 ||
    JSON.parse(new TextDecoder().decode(bytes)).address !== source.programId
  )
    throw new Error("IDL không khớp chương trình");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  await writeFile(`packages/chains/idl/${source.file}`, bytes);
  results.push({ ...source, url, sha256 });
}
await writeFile(
  "packages/chains/idl/manifest.json",
  JSON.stringify({ version: 1, sources: results }, null, 2) + "\n",
);
process.stdout.write(
  `Đã tải và ghim ${sources.length} IDL từ repository chính thức.\n`,
);
