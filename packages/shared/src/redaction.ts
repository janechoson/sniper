const sensitive =
  /private.?key|mnemonic|seed|secret|authorization|api.?key|access.?token|rpc.*url|database.?url|password/i;
export function redactSecrets(
  input: unknown,
  depth = 0,
  seen = new WeakSet<object>(),
): unknown {
  if (depth > 12) return "[DEPTH_LIMIT]";
  if (input === null || typeof input !== "object")
    return typeof input === "bigint" ? input.toString() : input;
  if (seen.has(input)) return "[CIRCULAR]";
  seen.add(input);
  if (input instanceof Error)
    return { name: input.name, message: "[ERROR_DETAILS_REDACTED]" };
  if (Array.isArray(input))
    return input
      .slice(0, 1000)
      .map((value) => redactSecrets(value, depth + 1, seen));
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input).slice(0, 1000))
    result[key] = sensitive.test(key)
      ? "[REDACTED]"
      : redactSecrets(value, depth + 1, seen);
  return result;
}
