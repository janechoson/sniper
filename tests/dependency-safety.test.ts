import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { it, expect } from "vitest";
const require = createRequire(import.meta.url);
it("SPL dùng bigint JavaScript với buffer dài, không nạp native addon", () => {
  const spl = createRequire(require.resolve("@solana/spl-token"));
  const layout = createRequire(spl.resolve("@solana/buffer-layout-utils"));
  const path = layout.resolve("bigint-buffer");
  const bigint = layout("bigint-buffer") as {
    toBigIntLE: (b: Buffer) => bigint;
    toBigIntBE: (b: Buffer) => bigint;
    toBufferLE: (n: bigint, w: number) => Buffer;
    toBufferBE: (n: bigint, w: number) => Buffer;
  };
  expect(readFileSync(path, "utf8")).not.toContain("require('bindings')");
  const large = Buffer.alloc(64, 255);
  expect(bigint.toBigIntLE(large)).toBe((1n << 512n) - 1n);
  expect(bigint.toBigIntBE(Buffer.alloc(0))).toBe(0n);
  const number = (1n << 127n) + 123n;
  expect(bigint.toBigIntLE(bigint.toBufferLE(number, 16))).toBe(number);
  expect(bigint.toBigIntBE(bigint.toBufferBE(number, 16))).toBe(number);
  const original = Buffer.from([1, 2, 3, 4]);
  bigint.toBigIntLE(original);
  expect(original).toEqual(Buffer.from([1, 2, 3, 4]));
});
it("TOML đã vá vẫn đọc được Buffer Anchor.toml theo API của Anchor", () => {
  const anchor = createRequire(require.resolve("@coral-xyz/anchor"));
  const toml = anchor("toml") as { parse: (source: Buffer) => unknown };
  expect(
    toml.parse(Buffer.from('[programs.localnet]\nfixture = "address"\n')),
  ).toMatchObject({ programs: { localnet: { fixture: "address" } } });
});
