import { PublicKey, type AccountInfo } from "@solana/web3.js";
import {
  unpackMint,
  getExtensionTypes,
  getTransferFeeConfig,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ExtensionType,
  getDefaultAccountState,
  AccountState,
  getTransferHook,
  getPermanentDelegate,
  getMetadataPointerState,
} from "@solana/spl-token";
import { z } from "zod";
import type { SecurityAnalysis, TokenInfo } from "@sniper/core";
import type { JsonRpcClient } from "../rpc/http";
import { rpcEvidence } from "./evidence";
export const solanaAccountSchema = z.object({
  data: z.tuple([z.string(), z.literal("base64")]),
  owner: z.string(),
  executable: z.boolean(),
  lamports: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  rentEpoch: z.number().optional(),
});
export type SolanaAccount = z.infer<typeof solanaAccountSchema>;
export function accountInfo(account: SolanaAccount): AccountInfo<Buffer> {
  return {
    data: Buffer.from(account.data[0], "base64"),
    owner: new PublicKey(account.owner),
    executable: account.executable,
    lamports: account.lamports,
  };
}
const accountResponse = z.object({
  context: z.object({ slot: z.number().int().nonnegative() }),
  value: solanaAccountSchema.nullable(),
});
export class SolanaTokenAnalyzer {
  invalidate(address: string) {
    this.cache.delete(address);
  }
  private cache = new Map<
    string,
    { at: number; value: { info: TokenInfo; security: SecurityAnalysis } }
  >();
  constructor(
    private readonly rpc: JsonRpcClient,
    private readonly ttlMs = 30000,
    private readonly maxCache = 512,
  ) {}
  async analyze(
    address: string,
  ): Promise<{ info: TokenInfo; security: SecurityAnalysis }> {
    const key = new PublicKey(address);
    const cached = this.cache.get(address);
    if (cached && Date.now() - cached.at < this.ttlMs)
      return structuredClone(cached.value);
    const response = await this.rpc.request(
      "getAccountInfo",
      [key.toBase58(), { encoding: "base64", commitment: "confirmed" }],
      accountResponse,
    );
    if (!response.value)
      return {
        info: { address },
        security: {
          validToken: false,
          evidence: ["RPC getAccountInfo: không tồn tại mint"],
        },
      };
    const owner = new PublicKey(response.value.owner);
    if (!owner.equals(TOKEN_PROGRAM_ID) && !owner.equals(TOKEN_2022_PROGRAM_ID))
      return {
        info: { address },
        security: {
          validToken: false,
          evidence: ["Tài khoản không thuộc Token Program hoặc Token-2022"],
        },
      };
    let mint;
    try {
      mint = unpackMint(key, accountInfo(response.value), owner);
    } catch {
      return {
        info: { address },
        security: {
          validToken: false,
          evidence: [
            "Không giải mã được mint bằng thư viện SPL Token chính thức",
          ],
        },
      };
    }
    const extensions = getExtensionTypes(mint.tlvData);
    const benign = new Set([
      ExtensionType.MetadataPointer,
      ExtensionType.TokenMetadata,
      ExtensionType.GroupPointer,
      ExtensionType.TokenGroup,
      ExtensionType.GroupMemberPointer,
      ExtensionType.TokenGroupMember,
      ExtensionType.ImmutableOwner,
    ]);
    const fee = getTransferFeeConfig(mint);
    const transferFeePct = fee
      ? Math.max(
          fee.olderTransferFee.transferFeeBasisPoints,
          fee.newerTransferFee.transferFeeBasisPoints,
        ) / 100
      : 0;
    const dangerous = extensions.some(
      (extension) =>
        !benign.has(extension) && extension !== ExtensionType.TransferFeeConfig,
    );
    const frozen = getDefaultAccountState(mint)?.state === AccountState.Frozen;
    const mintRisk = mint.mintAuthority !== null;
    const freezeRisk = mint.freezeAuthority !== null;
    const restriction = dangerous || frozen;
    const security: SecurityAnalysis = {
      validToken: mint.isInitialized,
      mintRisk,
      freezeRisk,
      transferRestrictionRisk: restriction,
      sellRestrictionRisk: restriction,
      tokenProgram: owner.toBase58(),
      buyTaxPct: transferFeePct,
      sellTaxPct: transferFeePct,
      overallRisk: mintRisk || restriction ? 100 : transferFeePct > 0 ? 20 : 0,
      evidence: [
        `RPC mint slot=${response.context.slot}; program=${owner.toBase58()}`,
        `mintAuthority=${mint.mintAuthority?.toBase58() ?? "NONE"}; freezeAuthority=${mint.freezeAuthority?.toBase58() ?? "NONE"}`,
        `Token-2022 extension types=${extensions.join(",") || "NONE"}`,
        "Điểm rủi ro theo quy tắc chỉ phản ánh quyền của mint; chưa chứng minh an toàn của bể hoặc tuyến bán",
      ],
    };
    const findings: NonNullable<SecurityAnalysis["onChainFindings"]> = [];
    const add = (
      field: string,
      value: Parameters<typeof rpcEvidence>[0],
      state: Parameters<typeof rpcEvidence>[1] = "SAFE",
      section: "contract" | "trading" = "contract",
    ) =>
      findings.push({
        section,
        field,
        evidence: rpcEvidence(
          value,
          state,
          `mint slot=${response.context.slot}`,
        ),
      });
    add("validToken", mint.isInitialized, mint.isInitialized ? "SAFE" : "RISK");
    add("tokenProgram", owner.toBase58());
    add("supply", mint.supply.toString());
    add("decimals", mint.decimals);
    add(
      "mintAuthority",
      mint.mintAuthority ? "ACTIVE" : "REVOKED",
      mint.mintAuthority ? "RISK" : "SAFE",
    );
    add(
      "freezeAuthority",
      mint.freezeAuthority ? "ACTIVE" : "REVOKED",
      mint.freezeAuthority ? "RISK" : "SAFE",
    );
    add("mintCapability", mintRisk, mintRisk ? "RISK" : "SAFE");
    add(
      "extensions",
      extensions.map((t) => ExtensionType[t] ?? String(t)).join(",") || "NONE",
    );
    const hook = getTransferHook(mint),
      delegate = getPermanentDelegate(mint),
      metadata = getMetadataPointerState(mint);
    const zero=new PublicKey(new Uint8Array(32));
    const hookActive=!!hook?.programId&&!hook.programId.equals(zero);
    add("transferHook",hookActive?hook!.programId.toBase58():"NONE",hookActive?"RISK":"SAFE");
    add(
      "permanentDelegate",
      delegate&&!delegate.delegate.equals(zero)?delegate.delegate.toBase58():"NONE",
      delegate&&!delegate.delegate.equals(zero) ? "RISK" : "SAFE",
    );
    add(
      "defaultAccountState",
      getDefaultAccountState(mint)?.state === AccountState.Frozen
        ? "FROZEN"
        : "INITIALIZED",
      frozen ? "RISK" : "SAFE",
    );
    const nontransfer = extensions.includes(ExtensionType.NonTransferable);
    add("nonTransferable", nontransfer, nontransfer ? "RISK" : "SAFE");
    if (metadata)
      add("metadataAuthority", metadata.authority?.toBase58() ?? "REVOKED");
    if (frozen || nontransfer) add("transferRestriction", true, "RISK");
    else if (!dangerous) add("transferRestriction", false, "SAFE");
    add("buyTaxPct", transferFeePct, "SAFE", "trading");
    add("sellTaxPct", transferFeePct, "SAFE", "trading");
    if (fee)
      add(
        "mutableTaxes",
        !fee.transferFeeConfigAuthority.equals(zero),
        !fee.transferFeeConfigAuthority.equals(zero) ? "RISK" : "SAFE",
      );
    security.onChainFindings = findings;
    const value = {
      info: {
        address,
        decimals: mint.decimals,
        totalSupply: mint.supply.toString(),
        tokenProgram: owner.toBase58(),
      },
      security,
    };
    if (this.cache.size >= this.maxCache)
      this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(address, { at: Date.now(), value });
    return structuredClone(value);
  }
}
