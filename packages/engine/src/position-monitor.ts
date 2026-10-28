import type { NormalizedTokenState, Position, TradeQuote } from "@sniper/core";
import type { Settings } from "@sniper/config";
import type { Executor } from "@sniper/execution";
import type { RouteEngine } from "@sniper/routing";
import { markPosition, ExitEngine } from "@sniper/positions";
export interface PositionUpdate {
  position: Position;
  failed: boolean;
  exit?: { type: string; reason: string; quote: TradeQuote };
}
export async function monitorPosition(
  position: Position,
  state: NormalizedTokenState,
  settings: Settings,
  now: number,
  routes: RouteEngine,
  executor: Executor,
): Promise<PositionUpdate> {
  if (state.market.priceUsd === undefined) return { position, failed: false };
  let next = markPosition(position, state.market.priceUsd);
  const exit = new ExitEngine().evaluate(next, state, settings, now);
  if (!exit) return { position: next, failed: false };
  try {
    const quote = await routes.quote({
      chainId: position.chainId,
      tokenAddress: position.tokenAddress,
      side: "SELL",
      amount: exit.quantity,
      slippageBps: 50,
    });
    const simulation = await routes.simulate(quote);
    if (!simulation.success) throw new Error("Mô phỏng bán thất bại");
    next = await executor.close(
      next,
      { ...quote, expectedOutput: simulation.receivedAmount! },
      exit.reason,
      now,
      exit.level,
    );
    return {
      position: next,
      failed: false,
      exit: {
        type: exit.reason.startsWith("TAKE_PROFIT")
          ? "take_profit"
          : exit.reason === "STOP_LOSS"
            ? "stop_loss"
            : "position_exit",
        reason: exit.reason,
        quote,
      },
    };
  } catch {
    return {
      position: { ...next, exitState: `EXIT_RETRY:${exit.reason}` },
      failed: true,
    };
  }
}
