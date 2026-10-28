import type { NormalizedTokenState } from "@sniper/core";
export class MockMarketBook {
  private seeds = new Map<string, NormalizedTokenState>();
  private key(chainId: string, address: string) {
    return `${chainId}/${address}`;
  }
  register(state: NormalizedTokenState) {
    if (state.identity.source !== "MOCK")
      throw new Error("Chỉ hỗ trợ thị trường giả lập");
    this.seeds.set(
      this.key(state.identity.chainId, state.identity.address),
      structuredClone(state),
    );
  }
  state(
    chainId: string,
    address: string,
    now: number,
  ): NormalizedTokenState | undefined {
    const seed = this.seeds.get(this.key(chainId, address));
    if (!seed) return;
    const state = structuredClone(seed);
    const elapsed = Math.max(0, (now - seed.observedAt) / 1000);
    const index = Number(address.split(":").at(-1)) || 0;
    let multiple: number;
    if (index % 3 === 1) multiple = Math.max(0.45, 1 - elapsed * 0.035);
    else if (index % 3 === 0)
      multiple =
        elapsed < 45
          ? 1 + elapsed * 0.03
          : Math.max(1.1, 2.35 - (elapsed - 45) * 0.06);
    else
      multiple =
        elapsed < 60
          ? 1 + elapsed * 0.02
          : Math.max(0.7, 2.2 - (elapsed - 60) * 0.04);
    state.observedAt = now;
    state.identity.ageSec = (seed.identity.ageSec ?? 0) + elapsed;
    if (seed.market.priceUsd !== undefined)
      state.market.priceUsd = seed.market.priceUsd * multiple;
    return state;
  }
  quoteMarket(chainId: string, address: string, now: number) {
    const state = this.state(chainId, address, now);
    if (
      state?.market.priceUsd === undefined ||
      state.market.liquidityUsd === undefined
    )
      return;
    return {
      priceUsd: state.market.priceUsd,
      liquidityUsd: state.market.liquidityUsd,
    };
  }
}
