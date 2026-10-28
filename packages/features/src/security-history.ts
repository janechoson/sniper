import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Repository } from "@sniper/storage";
import type { CreatorDataProvider } from "./providers";
import type {
  TokenSecurityProvider,
  TokenSecurityRequest,
  TokenSecurityProviderResult,
  RugCheckSnapshot,
  HolderCluster,
} from "@sniper/core";
import { measured } from "./rug-check";
const observation = z.object({
  chainId: z.string(),
  tokenAddress: z.string(),
  creatorAddress: z.string(),
  role: z.enum(["TOKEN_DEPLOYER", "POOL_CREATOR", "TOKEN_CREATOR"]),
  observedAt: z.number(),
  firstObservedAt: z.number(),
  active: z.boolean().nullable(),
  liquidityUsd: z.number().nullable(),
  top10Pct: z.number().nullable(),
  sellability: z.enum(["SELLABLE", "NOT_SELLABLE", "UNKNOWN"]),
});
const incident = z
  .object({
    id: z.string(),
    chainId: z.string(),
    tokenAddress: z.string(),
    creatorAddress: z.string(),
    actorAddress: z.string(),
    kind: z.enum([
      "LIQUIDITY_REMOVAL_CONFIRMED",
      "REPEATED_SELL_SIMULATION_FAILURE",
      "SECURITY_CONFIGURATION_INCIDENT",
    ]),
    evidenceReference: z.string().min(1).max(300),
    origin: z.enum(["REAL_ONCHAIN", "REAL_SIMULATION"]),
    observedAt: z.number(),
  })
  .strict();
export type CreatorSecurityIncident = z.infer<typeof incident>;
export class CreatorIntelligenceProvider implements TokenSecurityProvider {
  readonly id = "internal-creator";
  private observations = new Map<string, z.infer<typeof observation>>();
  private incidents = new Map<string, CreatorSecurityIncident>();
  constructor(
    private readonly repository: Repository,
    private readonly creators: CreatorDataProvider,
  ) {}
  private address(chain: string, address: string) {
    return chain === "solana" ? address : address.toLowerCase();
  }
  private key(chain: string, token: string) {
    return `${chain}:${this.address(chain, token)}`;
  }
  supports() {
    return true;
  }
  async healthCheck() {
    return {
      id: this.id,
      status: "READY" as const,
      reasons: [],
      checkedAt: Date.now(),
    };
  }
  async restore() {
    for (const row of await this.repository.read())
      if (row.kind === "rug.creator-observation") {
        const value = observation.parse(row.payload);
        this.observations.set(
          this.key(value.chainId, value.tokenAddress),
          value,
        );
      } else if (row.kind === "rug.creator-incident") {
        const value = incident.parse(row.payload);
        this.incidents.set(value.id, value);
      }
  }
  async recordIncident(input: CreatorSecurityIncident) {
    const value = incident.parse(input);
    if (
      this.address(value.chainId, value.actorAddress) !==
      this.address(value.chainId, value.creatorAddress)
    )
      throw new Error("CREATOR_INCIDENT_ACTOR_UNPROVEN");
    const relationship = await this.creators.getCreatorAnalysis(
      value.chainId,
      value.tokenAddress,
    );
    if (
      !relationship.address ||
      this.address(value.chainId, relationship.address) !==
        this.address(value.chainId, value.creatorAddress)
    )
      throw new Error("CREATOR_INCIDENT_RELATION_UNPROVEN");
    if (this.incidents.has(value.id)) return;
    await this.repository.append({
      id: `rug-incident:${value.id}`,
      kind: "rug.creator-incident",
      chainId: value.chainId,
      tokenAddress: value.tokenAddress,
      payload: value,
      createdAt: value.observedAt,
    });
    this.incidents.set(value.id, value);
  }
  async observe(snapshot: RugCheckSnapshot) {
    const creator = snapshot.creator.address,
      role = snapshot.creator.role;
    if (
      creator?.origin !== "REAL_INTERNAL" ||
      typeof creator.value !== "string" ||
      !role ||
      !["TOKEN_DEPLOYER", "POOL_CREATOR", "TOKEN_CREATOR"].includes(
        String(role.value),
      )
    )
      return;
    const key = this.key(snapshot.chainId, snapshot.tokenAddress),
      old = this.observations.get(key);
    const valid = snapshot.contract.validToken,
      liq = snapshot.liquidity.usd,
      top = snapshot.holders.top10Pct,
      sell = snapshot.trading.sellability;
    const value = observation.parse({
      chainId: snapshot.chainId,
      tokenAddress: snapshot.tokenAddress,
      creatorAddress: creator.value,
      role: role.value,
      observedAt: Date.now(),
      firstObservedAt: old?.firstObservedAt ?? Date.now(),
      active:
        valid?.state !== "UNKNOWN" && typeof valid?.value === "boolean"
          ? valid.value
          : null,
      liquidityUsd: typeof liq?.value === "number" ? liq.value : null,
      top10Pct: typeof top?.value === "number" ? top.value : null,
      sellability:
        sell?.value === "SELLABLE" || sell?.value === "NOT_SELLABLE"
          ? sell.value
          : "UNKNOWN",
    });
    await this.repository.append({
      id: randomUUID(),
      kind: "rug.creator-observation",
      chainId: value.chainId,
      tokenAddress: value.tokenAddress,
      payload: value,
      createdAt: value.observedAt,
    });
    this.observations.set(key, value);
  }
  async analyze(
    request: TokenSecurityRequest,
  ): Promise<TokenSecurityProviderResult> {
    const start = Date.now(),
      profile = await this.creators.getCreatorAnalysis(
        request.chainId,
        request.tokenAddress,
      ),
      result: TokenSecurityProviderResult = {
        provider: this.id,
        chainId: request.chainId,
        tokenAddress: request.tokenAddress,
        status: "OK",
        checkedAt: new Date().toISOString(),
        latencyMs: 0,
        findings: [],
      };
    if (!profile.address) return result;
    const add = (
      field: string,
      value: string | number,
      state: "SAFE" | "RISK" = "SAFE",
    ) =>
      result.findings.push({
        section: "creator",
        field,
        evidence: measured(value, this.id, "REAL_INTERNAL", state),
      });
    add("address", profile.address);
    if (profile.role) add("role", profile.role);
    add("history", "OBSERVED_DATASET_ONLY");
    if (profile.previousTokens !== undefined)
      add("previousTokens", profile.previousTokens);
    const previous = [...this.observations.values()].filter(
      (row) =>
        row.chainId === request.chainId &&
        this.address(request.chainId, row.creatorAddress) ===
          this.address(request.chainId, profile.address!) &&
        this.address(request.chainId, row.tokenAddress) !==
          this.address(request.chainId, request.tokenAddress),
    );
    if (previous.length && previous.every((p) => p.active !== null))
      add("activeTokens", previous.filter((p) => p.active).length);
    const incidents = [...this.incidents.values()].filter(
      (row) =>
        row.chainId === request.chainId &&
        this.address(row.chainId, row.creatorAddress) ===
          this.address(request.chainId, profile.address!),
    );
    // Số 0 chỉ là không có incident trong dataset; history vẫn ghi phạm vi hữu hạn.
    add(
      "criticalIncidents",
      incidents.length,
      incidents.length ? "RISK" : "SAFE",
    );
    const removals = incidents.filter(
      (i) => i.kind === "LIQUIDITY_REMOVAL_CONFIRMED",
    ).length;
    add("liquidityRemovals", removals, removals ? "RISK" : "SAFE");
    const sellFailures = incidents.filter(
      (i) => i.kind === "REPEATED_SELL_SIMULATION_FAILURE",
    ).length;
    add("sellabilityFailures", sellFailures, sellFailures ? "RISK" : "SAFE");
    result.latencyMs = Date.now() - start;
    return result;
  }
}
export const fundingObservationSchema = z
  .object({
    chainId: z.string(),
    tokenAddress: z.string(),
    wallet: z.string(),
    funder: z.string(),
    transactionId: z.string().min(1),
    observedAt: z.number(),
    firstFunderVerified: z.boolean(),
  })
  .strict();
export class InternalHolderClusterProvider {
  private rows = new Map<string, z.infer<typeof fundingObservationSchema>>();
  constructor(private readonly repository: Repository) {}
  private key(value: z.infer<typeof fundingObservationSchema>) {
    return `${value.chainId}:${value.transactionId}:${value.wallet}`;
  }
  private remember(value: z.infer<typeof fundingObservationSchema>) {
    this.rows.set(this.key(value), value);
    if (this.rows.size > 5000) this.rows.delete(this.rows.keys().next().value!);
  }
  async restore() {
    for (const entry of await this.repository.read())
      if (entry.kind === "rug.holder-funding")
        this.remember(fundingObservationSchema.parse(entry.payload));
  }
  async record(value: z.infer<typeof fundingObservationSchema>) {
    value = fundingObservationSchema.parse(value);
    const key = this.key(value);
    if (this.rows.has(key)) return;
    await this.repository.append({
      id: `holder-funding:${key}`,
      kind: "rug.holder-funding",
      chainId: value.chainId,
      tokenAddress: value.tokenAddress,
      payload: value,
      createdAt: value.observedAt,
    });
    this.remember(value);
  }
  async getClusters(request: TokenSecurityRequest) {
    return clusterHolderFunding(
      [...this.rows.values()],
      request.chainId,
      request.tokenAddress,
    );
  }
}
export function clusterHolderFunding(
  input: z.infer<typeof fundingObservationSchema>[],
  chainId: string,
  tokenAddress: string,
): HolderCluster[] {
  const normalize = (address: string) =>
    chainId === "solana" ? address : address.toLowerCase();
  const groups = new Map<string, z.infer<typeof fundingObservationSchema>[]>();
  for (const raw of input.slice(0, 500)) {
    const value = fundingObservationSchema.parse(raw);
    if (
      value.chainId !== chainId ||
      normalize(value.tokenAddress) !== normalize(tokenAddress)
    )
      continue;
    const key = normalize(value.funder),
      rows = groups.get(key) ?? [];
    if (!rows.some((r) => normalize(r.wallet) === normalize(value.wallet)))
      rows.push(value);
    groups.set(key, rows);
  }
  return [...groups.values()]
    .filter((rows) => rows.length >= 2)
    .slice(0, 50)
    .map((rows) => ({
      wallets: rows.map((row) => row.wallet),
      confidence:
        rows.length >= 3 && rows.every((row) => row.firstFunderVerified)
          ? "STRONG_SIGNAL"
          : "WEAK_SIGNAL",
      reasonCodes: [
        "COMMON_FUNDER_OBSERVED",
        "COMMON_FUNDER_DOES_NOT_PROVE_COMMON_OWNER",
      ],
      evidence: rows.slice(0, 30).map((row) => ({
        ...measured(
          row.funder,
          "internal-transfer-index",
          "REAL_INTERNAL",
          "RISK",
          new Date(row.observedAt).toISOString(),
        ),
        reference: row.transactionId,
      })),
    }));
}
