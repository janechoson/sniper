import { z } from "zod";
import { JsonRpcClient } from "../rpc/http";
const instruction = z.object({
  programIdIndex: z.number().int(),
  accounts: z.array(z.number().int()),
  data: z.string(),
});
export const transactionSchema = z
  .object({
    version: z
      .union([z.literal("legacy"), z.literal(0), z.literal(1)])
      .optional(),
    slot: z.number().int(),
    blockTime: z.number().nullable(),
    transaction: z.object({
      message: z.object({
        accountKeys: z.array(z.string()),
        instructions: z.array(instruction),
      }),
    }),
    meta: z
      .object({
        err: z.unknown().nullable(),
        logMessages: z.array(z.string()).nullable().optional(),
        innerInstructions: z
          .array(
            z.object({ index: z.number(), instructions: z.array(instruction) }),
          )
          .nullable(),
        loadedAddresses: z
          .object({
            writable: z.array(z.string()),
            readonly: z.array(z.string()),
          })
          .optional(),
      })
      .nullable(),
  })
  .nullable();

export type SolanaTransaction = NonNullable<z.infer<typeof transactionSchema>>;
/** Một lần fetch cho mỗi signature dù nhiều chương trình cùng xuất hiện trong transaction. */
export class SolanaTransactionReader {
  private cache = new Map<
    string,
    {
      at: number;
      work: Promise<z.infer<typeof transactionSchema>>;
      settled: boolean;
    }
  >();
  constructor(private readonly rpc: JsonRpcClient) {}
  read(signature: string) {
    const old = this.cache.get(signature);
    if (old && (!old.settled || Date.now() - old.at < 30000)) return old.work;
    if (this.cache.size >= 256) {
      const removable = [...this.cache].find(([, value]) => value.settled);
      if (!removable)
        return Promise.reject(new Error("TRANSACTION_READ_BACKPRESSURE"));
      this.cache.delete(removable[0]);
    }
    const work = this.rpc.request(
      "getTransaction",
      [
        signature,
        {
          encoding: "json",
          commitment: "confirmed",
          maxSupportedTransactionVersion: 1,
        },
      ],
      transactionSchema,
    );
    this.cache.set(signature, { at: Date.now(), work, settled: false });
    void work.then(
      (value) => {
        const entry = this.cache.get(signature);
        if (entry?.work === work) entry.settled = true;
        if (!value && this.cache.get(signature)?.work === work)
          this.cache.delete(signature);
      },
      () => {
        if (this.cache.get(signature)?.work === work)
          this.cache.delete(signature);
      },
    );
    return work;
  }
}
