import { keccak256, toHex } from "viem";
export const NATIVE_ADDRESS = "0x0000000000000000000000000000000000000000";
export const nativeAsset = (a: string) => a.toLowerCase() === NATIVE_ADDRESS;
export const transferTopic = keccak256(
  toHex("Transfer(address,address,uint256)"),
);
export function tracedNativeDelta(
  logs: { address: string; topics: string[]; data: string }[],
  wallet: string,
) {
  let delta = 0n;
  for (const log of logs) {
    if (
      log.address.toLowerCase() !==
        "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" ||
      log.topics[0] !== transferTopic ||
      log.topics.length !== 3
    )
      continue;
    const address = wallet.toLowerCase().slice(2);
    if (log.topics[1]!.toLowerCase().slice(-40) === address)
      delta -= BigInt(log.data);
    if (log.topics[2]!.toLowerCase().slice(-40) === address)
      delta += BigInt(log.data);
  }
  return delta;
}
/** callTracer evidence for mined native settlement; reverted subtrees contribute 0. */
export function callTraceNativeDelta(input: unknown, wallet: string): bigint {
  let nodes = 0;
  const walk = (value: unknown, depth: number): bigint => {
    if (depth > 64 || ++nodes > 10000 || !value || typeof value !== "object")
      throw Error("NATIVE_TRACE_INVALID");
    const call = value as Record<string, unknown>;
    if (call.error) return 0n;
    const kind = String(call.type).toUpperCase();
    if (
      ![
        "CALL",
        "STATICCALL",
        "DELEGATECALL",
        "CALLCODE",
        "CREATE",
        "CREATE2",
      ].includes(kind)
    )
      throw Error("NATIVE_TRACE_UNSUPPORTED");
    let delta = 0n;
    if (["CALL", "CREATE", "CREATE2"].includes(kind)) {
      const amount = BigInt(String(call.value ?? "0x0"));
      if (amount < 0n || amount >= 2n ** 256n)
        throw Error("NATIVE_TRACE_INVALID");
      if (String(call.from).toLowerCase() === wallet.toLowerCase())
        delta -= amount;
      if (String(call.to).toLowerCase() === wallet.toLowerCase())
        delta += amount;
    }
    if (call.calls !== undefined && !Array.isArray(call.calls))
      throw Error("NATIVE_TRACE_INVALID");
    for (const child of (call.calls ?? []) as unknown[])
      delta += walk(child, depth + 1);
    return delta;
  };
  return walk(input, 0);
}
