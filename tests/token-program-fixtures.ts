import {
  ACCOUNT_SIZE,
  ACCOUNT_TYPE_SIZE,
  AccountType,
  ExtensionType,
  getTypeLen,
  LENGTH_SIZE,
  MetadataPointerLayout,
  MINT_SIZE,
  MintLayout,
  TOKEN_2022_PROGRAM_ID,
  TYPE_SIZE,
} from "@solana/spl-token";
import { pack } from "@solana/spl-token-metadata";
import { PublicKey, type AccountInfo } from "@solana/web3.js";
import { MINT } from "./fixtures.js";
export function mintFixture(
  program = TOKEN_2022_PROGRAM_ID,
  extensions: { type: number; data: Buffer }[] = [],
  decimals = 6,
): AccountInfo<Buffer> {
  const base = Buffer.alloc(MINT_SIZE);
  MintLayout.encode(
    {
      mintAuthorityOption: 0,
      mintAuthority: PublicKey.default,
      supply: 1000000n,
      decimals,
      isInitialized: true,
      freezeAuthorityOption: 0,
      freezeAuthority: PublicKey.default,
    },
    base,
  );
  let data = base;
  if (extensions.length) {
    const padding = Buffer.alloc(ACCOUNT_SIZE + ACCOUNT_TYPE_SIZE);
    base.copy(padding);
    padding[ACCOUNT_SIZE] = AccountType.Mint;
    data = Buffer.concat([
      padding,
      ...extensions.map((e) => {
        const header = Buffer.alloc(TYPE_SIZE + LENGTH_SIZE);
        header.writeUInt16LE(e.type, 0);
        header.writeUInt16LE(e.data.length, TYPE_SIZE);
        return Buffer.concat([header, e.data]);
      }),
    ]);
  }
  return {
    owner: program,
    data,
    lamports: 1000000,
    executable: false,
    rentEpoch: 0,
  };
}
export function metadataFixture() {
  const address = new PublicKey(MINT),
    pointer = Buffer.alloc(getTypeLen(ExtensionType.MetadataPointer));
  MetadataPointerLayout.encode(
    { authority: PublicKey.default, metadataAddress: address },
    pointer,
  );
  return mintFixture(TOKEN_2022_PROGRAM_ID, [
    { type: ExtensionType.MetadataPointer, data: pointer },
    {
      type: ExtensionType.TokenMetadata,
      data: Buffer.from(
        pack({
          mint: address,
          name: "Fixture",
          symbol: "FIX",
          uri: "https://example.invalid",
          additionalMetadata: [],
        }),
      ),
    },
  ]);
}
