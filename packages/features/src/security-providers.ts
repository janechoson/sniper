import { z } from "zod";
import type {
  TokenSecurityProvider,
  TokenSecurityRequest,
  TokenSecurityProviderResult,
  SecurityEvidence,
} from "@sniper/core";
import { securityProviderResultSchema } from "@sniper/core";
import { measured } from "./rug-check";
const flag = z.enum(["0", "1", ""]).nullable().optional();
const optionalString = z.string().max(200).nullable().optional();
const goplusToken = z.object({
  is_open_source: flag,
  is_proxy: flag,
  is_mintable: flag,
  owner_change_balance: flag,
  hidden_owner: flag,
  external_call: flag,
  is_blacklisted: flag,
  is_whitelisted: flag,
  transfer_pausable: flag,
  slippage_modifiable: flag,
  is_honeypot: flag,
  cannot_buy: flag,
  cannot_sell_all: flag,
  buy_tax: optionalString,
  sell_tax: optionalString,
  transfer_tax: optionalString,
  holder_count: optionalString,
  creator_address: optionalString,
  creator_percent: optionalString,
  holders: z
    .array(z.object({ address: z.string(), percent: optionalString }))
    .max(10)
    .optional(),
});
const goplusResponse = z.object({
  code: z.number().int(),
  result: z.record(z.string(), goplusToken).optional(),
});
const honeypotResponse = z.object({
  token: z.object({
    address: z.string(),
    totalHolders: z.number().int().nonnegative().optional(),
  }),
  chain: z.object({ id: z.string() }),
  simulationSuccess: z.boolean().optional(),
  honeypotResult: z.object({ isHoneypot: z.boolean() }).optional(),
  simulationResult: z
    .object({
      buyTax: z.number().finite().nonnegative().max(100).optional(),
      sellTax: z.number().finite().nonnegative().max(100).optional(),
      transferTax: z.number().finite().nonnegative().max(100).optional(),
    })
    .optional(),
  contractCode: z
    .object({
      openSource: z.boolean().optional(),
      isProxy: z.boolean().optional(),
    })
    .optional(),
  pairAddress: z.string().optional(),
});
const rugcheckResponse = z.object({
  mint: z.string().optional(),
  error: z.string().optional(),
  lpLockedPct: z.number().finite().min(0).max(100).optional(),
  risks: z
    .array(
      z.object({
        name: z.string().max(150),
        level: z.string().max(40),
        value: z.string().max(300).optional(),
      }),
    )
    .max(100)
    .optional(),
  tokenProgram: z.string().optional(),
});
export class ExternalSecurityProvider implements TokenSecurityProvider {
  private cache = new Map<
    string,
    { expires: number; result: TokenSecurityProviderResult }
  >();
  private inFlight = new Map<string, Promise<TokenSecurityProviderResult>>();
  private active = 0;
  private lastError?: string;
  private lastSuccess?: number;
  private supportedGoPlus?: { at: number; ids: Set<string> };
  constructor(
    readonly id: "goplus" | "honeypot" | "rugcheck",
    private readonly options: {
      enabled: boolean;
      evmChains: Map<string, number>;
      timeoutMs?: number;
      ttlMs?: number;
      fetcher?: typeof fetch;
    },
  ) {}
  supports(chainId: string) {
    return this.id === "rugcheck"
      ? chainId === "solana"
      : this.id === "honeypot"
        ? [1, 56, 8453].includes(this.options.evmChains.get(chainId) ?? -1)
        : this.options.evmChains.has(chainId);
  }
  async healthCheck() {
    return {
      id: this.id,
      status: !this.options.enabled
        ? ("DEGRADED" as const)
        : this.lastError
          ? ("DOWN" as const)
          : this.lastSuccess
            ? ("READY" as const)
            : ("DEGRADED" as const),
      reasons: !this.options.enabled
        ? ["PROVIDER_DISABLED"]
        : this.lastError
          ? [this.lastError]
          : this.lastSuccess
            ? []
            : ["PROVIDER_NOT_VERIFIED"],
      checkedAt: Date.now(),
    };
  }
  invalidate(chainId: string, tokenAddress: string) {
    this.cache.delete(
      `${chainId}:${chainId === "solana" ? tokenAddress : tokenAddress.toLowerCase()}`,
    );
  }
  private async get(url: string): Promise<unknown> {
    const controller = new AbortController(),
      timer = setTimeout(
        () => controller.abort(),
        this.options.timeoutMs ?? 4000,
      );
    try {
      const response = await (this.options.fetcher ?? fetch)(url, {
        method: "GET",
        headers: { accept: "application/json" },
        signal: controller.signal,
        redirect: "error",
      });
      if (!response.ok) throw new Error(`HTTP_${response.status}`);
      const reader = response.body?.getReader();
      if (!reader) throw new Error("EMPTY_BODY");
      const chunks: Uint8Array[] = [];
      let total = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > 1048576) {
            await reader.cancel();
            throw new Error("BODY_LIMIT");
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } finally {
      clearTimeout(timer);
    }
  }
  async analyze(
    request: TokenSecurityRequest,
  ): Promise<TokenSecurityProviderResult> {
    const key = `${request.chainId}:${request.chainId === "solana" ? request.tokenAddress : request.tokenAddress.toLowerCase()}`;
    const cached = this.cache.get(key);
    if (cached && cached.expires > Date.now())
      return structuredClone(cached.result);
    const pending = this.inFlight.get(key);
    if (pending) return structuredClone(await pending);
    const job = this.run(request);
    this.inFlight.set(key, job);
    try {
      const result = await job;
      if (result.status === "OK") {
        if (this.cache.size >= 300)
          this.cache.delete(this.cache.keys().next().value!);
        this.cache.set(key, {
          expires: Date.now() + Math.min(this.options.ttlMs ?? 5000, 30000),
          result: structuredClone(result),
        });
      }
      return result;
    } finally {
      this.inFlight.delete(key);
    }
  }
  private async run(
    request: TokenSecurityRequest,
  ): Promise<TokenSecurityProviderResult> {
    const start = Date.now(),
      at = new Date().toISOString();
    const result: TokenSecurityProviderResult = {
      provider: this.id,
      chainId: request.chainId,
      tokenAddress: request.tokenAddress,
      status: !this.options.enabled
        ? "DISABLED"
        : !this.supports(request.chainId)
          ? "UNSUPPORTED"
          : "OK",
      checkedAt: at,
      latencyMs: 0,
      findings: [],
      documentation:
        this.id === "goplus"
          ? "https://docs.gopluslabs.io/reference/response-details"
          : this.id === "honeypot"
            ? "https://docs.honeypot.is/ishoneypot"
            : "https://api.rugcheck.xyz/swagger/doc.json",
    };
    if (result.status !== "OK") return result;
    if (this.active >= 3)
      return {
        ...result,
        status: "UNAVAILABLE",
        error: "PROVIDER_BACKPRESSURE",
      };
    this.active++;
    const add = (
      section: "contract" | "trading" | "holders" | "liquidity" | "creator",
      field: string,
      value: SecurityEvidence["value"],
      state: SecurityEvidence["state"] = "SAFE",
    ) =>
      result.findings.push({
        section,
        field,
        evidence: {
          ...measured(value, this.id, "REAL_EXTERNAL", state, at),
          validUntil: new Date(
            start + Math.min(this.options.ttlMs ?? 5000, 30000),
          ).toISOString(),
        },
      });
    try {
      if (this.id === "goplus") {
        if (
          !this.supportedGoPlus ||
          Date.now() - this.supportedGoPlus.at > 3600000
        ) {
          const supported = z
            .object({
              code: z.literal(1),
              result: z.array(z.object({ id: z.string() })).max(300),
            })
            .parse(
              await this.get(
                "https://api.gopluslabs.io/api/v1/supported_chains",
              ),
            );
          this.supportedGoPlus = {
            at: Date.now(),
            ids: new Set(supported.result.map((c) => c.id)),
          };
        }
        const chain = String(this.options.evmChains.get(request.chainId));
        if (!this.supportedGoPlus.ids.has(chain))
          return { ...result, status: "UNSUPPORTED" };
        if (!/^0x[\da-fA-F]{40}$/.test(request.tokenAddress))
          throw new Error("INVALID_ADDRESS");
        const response = goplusResponse.parse(
          await this.get(
            `https://api.gopluslabs.io/api/v1/token_security/${chain}?contract_addresses=${encodeURIComponent(request.tokenAddress)}`,
          ),
        );
        if (response.code !== 1) throw new Error("PROVIDER_RESULT_CODE");
        const token = Object.entries(response.result ?? {}).find(
          ([a]) => a.toLowerCase() === request.tokenAddress.toLowerCase(),
        )?.[1];
        if (!token) throw new Error("TOKEN_RESULT_MISSING");
        const map = {
          is_proxy: "proxy",
          is_mintable: "mintCapability",
          owner_change_balance: "supplyManipulation",
          hidden_owner: "privilegedRoles",
          external_call: "arbitraryExternalCalls",
          is_blacklisted: "blacklistCapability",
          is_whitelisted: "whitelistRestriction",
          transfer_pausable: "pauseCapability",
          slippage_modifiable: "mutableTaxes",
        } as const;
        for (const [key, field] of Object.entries(map) as [
          keyof typeof map,
          string,
        ][]) {
          const value = token[key];
          if (value === "0" || value === "1")
            add(
              "contract",
              field,
              value === "1",
              value === "1" ? "RISK" : "SAFE",
            );
        }
        if (token.is_open_source === "0" || token.is_open_source === "1")
          add("contract", "verifiedSource", token.is_open_source === "1");
        if (token.is_honeypot === "0" || token.is_honeypot === "1")
          add(
            "trading",
            "honeypot",
            token.is_honeypot === "1" ? "FAIL" : "PASS",
            token.is_honeypot === "1" ? "RISK" : "SAFE",
          );
        if (token.cannot_sell_all === "0" || token.cannot_sell_all === "1")
          add(
            "trading",
            "sellRestriction",
            token.cannot_sell_all === "1",
            token.cannot_sell_all === "1" ? "RISK" : "SAFE",
          );
        for (const [key, field] of [
          ["buy_tax", "buyTaxPct"],
          ["sell_tax", "sellTaxPct"],
          ["transfer_tax", "transferTaxPct"],
        ] as const) {
          const raw = token[key];
          if (raw !== null && raw !== undefined && /^\d+(\.\d+)?$/.test(raw)) {
            const number = Number(raw) * 100;
            if (Number.isFinite(number) && number <= 100)
              add("trading", field, number);
          }
        }
        if (token.holder_count && /^\d+$/.test(token.holder_count)) {
          const count = Number(token.holder_count);
          if (Number.isSafeInteger(count)) add("holders", "count", count);
        }
        if (
          token.holders?.length &&
          new Set(token.holders.map((h) => h.address.toLowerCase())).size ===
            token.holders.length &&
          token.holders.every(
            (h) =>
              /^0x[\da-fA-F]{40}$/.test(h.address) &&
              h.percent &&
              /^\d+(\.\d+)?$/.test(h.percent) &&
              Number(h.percent) <= 1,
          )
        ) {
          const percentages = token.holders
            .map((h) => Number(h.percent) * 100)
            .sort((a, b) => b - a);
          for (const count of [1, 5, 10])
            if (
              percentages.length >= count ||
              (token.holder_count &&
                Number(token.holder_count) === percentages.length)
            ) {
              const sum = percentages
                .slice(0, count)
                .reduce((a, b) => a + b, 0);
              if (sum <= 100) add("holders", `top${count}Pct`, sum);
            }
          add("holders", "coverage", "PROVIDER_TOP10_ONLY");
          // Không tự loại tag LP/burn rồi coi top10 còn lại là phân bố đầy đủ.
        }
        // creator_percent là deployer do provider báo; không gắn pool creator nội bộ.
        if (
          token.creator_address &&
          /^0x[\da-fA-F]{40}$/.test(token.creator_address)
        )
          add("creator", "address", token.creator_address);
      } else if (this.id === "honeypot") {
        const chain = this.options.evmChains.get(request.chainId)!;
        if (!/^0x[\da-fA-F]{40}$/.test(request.tokenAddress))
          throw new Error("INVALID_ADDRESS");
        const url = new URL("https://api.honeypot.is/v2/IsHoneypot");
        url.searchParams.set("address", request.tokenAddress);
        url.searchParams.set("chainID", String(chain));
        if (request.poolAddress)
          url.searchParams.set("pair", request.poolAddress);
        const response = honeypotResponse.parse(await this.get(url.toString()));
        if (
          response.token.address.toLowerCase() !==
            request.tokenAddress.toLowerCase() ||
          response.chain.id !== String(chain) ||
          (request.poolAddress &&
            response.pairAddress?.toLowerCase() !==
              request.poolAddress.toLowerCase())
        )
          throw new Error("PROVIDER_IDENTITY_MISMATCH");
        if (response.honeypotResult)
          add(
            "trading",
            "honeypot",
            response.honeypotResult.isHoneypot ? "FAIL" : "PASS",
            response.honeypotResult.isHoneypot ? "RISK" : "SAFE",
          );
        // simulationSuccess=false có thể do thiếu dữ liệu/liquidity; không biến lỗi dịch vụ thành honeypot.
        if (response.simulationSuccess === true && response.simulationResult)
          for (const [key, field] of [
            ["buyTax", "buyTaxPct"],
            ["sellTax", "sellTaxPct"],
            ["transferTax", "transferTaxPct"],
          ] as const) {
            const value = response.simulationResult[key];
            if (value !== undefined) add("trading", field, value);
          }
        if (response.token.totalHolders !== undefined)
          add("holders", "count", response.token.totalHolders);
        if (response.contractCode?.isProxy !== undefined)
          add(
            "contract",
            "proxy",
            response.contractCode.isProxy,
            response.contractCode.isProxy ? "RISK" : "SAFE",
          );
      } else {
        if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(request.tokenAddress))
          throw new Error("INVALID_ADDRESS");
        const response = rugcheckResponse.parse(
          await this.get(
            `https://api.rugcheck.xyz/v1/tokens/${encodeURIComponent(request.tokenAddress)}/report/summary`,
          ),
        );
        if (
          response.error ||
          (response.mint && response.mint !== request.tokenAddress)
        )
          throw new Error("PROVIDER_IDENTITY_OR_RESULT_ERROR");
        if (response.lpLockedPct !== undefined)
          add("liquidity", "lpLockedPct", response.lpLockedPct);
        if (response.tokenProgram)
          add("contract", "tokenProgram", response.tokenProgram);
        if (response.risks?.length)
          add(
            "contract",
            "externalWarnings",
            JSON.stringify(response.risks).slice(0, 1024),
            response.risks.some((r) => /danger|critical/i.test(r.level))
              ? "RISK"
              : "SAFE",
          );
      }
      this.lastError = undefined;
      this.lastSuccess = Date.now();
      result.latencyMs = Date.now() - start;
      return securityProviderResultSchema.parse(result);
    } catch {
      this.lastError = "EXTERNAL_SECURITY_UNAVAILABLE";
      return {
        ...result,
        status: "UNAVAILABLE",
        findings: [],
        error: this.lastError,
        latencyMs: Date.now() - start,
      };
    } finally {
      this.active--;
    }
  }
}
