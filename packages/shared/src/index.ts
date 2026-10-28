import pino from "pino";
import { redactSecrets } from "./redaction";
export { redactSecrets } from "./redaction";
export * from "./amounts";
export * from "./locks";
export const createLogger = (level = "info") =>
  pino({
    level,
    formatters: {
      log: (object) => redactSecrets(object) as Record<string, unknown>,
    },
    redact: {
      paths: [
        "privateKey",
        "mnemonic",
        "seedPhrase",
        "apiKey",
        "authorization",
        "rpcHttpUrl",
        "databaseUrl",
        "req.headers.authorization",
        "*.privateKey",
        "*.mnemonic",
        "*.apiKey",
      ],
      censor: "[REDACTED]",
    },
  });
export async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Thao tác quá thời gian chờ")),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
export async function retry<T>(
  operation: () => Promise<T>,
  attempts = 3,
): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await operation();
    } catch (error) {
      if (i >= attempts - 1) throw error;
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(500 * 2 ** i, 5000)),
      );
    }
  }
}
