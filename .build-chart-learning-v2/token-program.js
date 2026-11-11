import { PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ExtensionType, unpackMint, getExtensionTypes, getExtensionData, getTypeLen, getMetadataPointerState, getDefaultAccountState, AccountState, getMintCloseAuthority, getPermanentDelegate, getTransferFeeConfig, getAssociatedTokenAddressSync, unpackAccount, } from "@solana/spl-token";
import { unpack as unpackMetadata } from "@solana/spl-token-metadata";
import { CandidateRejected, Blocked, } from "./domain.js";
export { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID };
export function inspectMint(mint, info) {
    if (!info || info.executable)
        throw new CandidateRejected("INVALID_MINT_LAYOUT", { mint });
    const program = info.owner.equals(TOKEN_PROGRAM_ID)
        ? "LEGACY_SPL"
        : info.owner.equals(TOKEN_2022_PROGRAM_ID)
            ? "TOKEN_2022"
            : "UNSUPPORTED";
    if (program === "UNSUPPORTED")
        throw new CandidateRejected("UNSUPPORTED_TOKEN_PROGRAM", {
            mint,
            owner: info.owner.toBase58(),
        });
    try {
        const parsed = unpackMint(new PublicKey(mint), info, info.owner);
        if (!parsed.isInitialized ||
            parsed.decimals > 18 ||
            (program === "LEGACY_SPL" && info.data.length !== 82))
            throw new CandidateRejected("INVALID_MINT_LAYOUT", { mint });
        const extensions = [];
        const types = getExtensionTypes(parsed.tlvData);
        if (new Set(types).size !== types.length)
            throw new CandidateRejected("INVALID_MINT_LAYOUT", {
                mint,
                reason: "Duplicate extension",
            });
        for (const type of types) {
            const name = ExtensionType[type] ?? "UNKNOWN";
            const data = getExtensionData(type, parsed.tlvData);
            if (!data)
                throw new CandidateRejected("INVALID_MINT_LAYOUT", {
                    mint,
                    extensionTypeId: type,
                });
            if (name !== "UNKNOWN" &&
                type !== ExtensionType.TokenMetadata &&
                data.length !== getTypeLen(type))
                throw new CandidateRejected("INVALID_MINT_LAYOUT", {
                    mint,
                    extension: name,
                });
            let policy = "UNSUPPORTED", reason = "Extension semantics are outside the supported execution subset";
            let details;
            if (type === ExtensionType.MetadataPointer) {
                const pointer = getMetadataPointerState(parsed);
                if (!pointer)
                    throw new CandidateRejected("INVALID_MINT_LAYOUT", {
                        mint,
                        extension: name,
                    });
                details = {
                    authority: pointer.authority?.toBase58() ?? null,
                    metadataAddress: pointer.metadataAddress?.toBase58() ?? null,
                };
                policy =
                    !pointer.metadataAddress ||
                        pointer.metadataAddress.equals(new PublicKey(mint))
                        ? "SUPPORTED_WITH_VALIDATION"
                        : "UNSUPPORTED";
                reason =
                    policy === "UNSUPPORTED"
                        ? "External metadata pointer is not resolved by this execution path"
                        : "Only metadata is mutable; pointer is null or references this mint";
            }
            else if (type === ExtensionType.TokenMetadata) {
                const metadata = unpackMetadata(data);
                if (!metadata.mint.equals(new PublicKey(mint))) {
                    policy = "CRITICAL_RISK";
                    reason = "Metadata references a different mint";
                }
                else {
                    policy = "SUPPORTED_WITH_VALIDATION";
                    reason =
                        "Official metadata codec validated the matching mint; display strings never authorize execution";
                }
            }
            else if (type === ExtensionType.DefaultAccountState) {
                const state = getDefaultAccountState(parsed);
                policy =
                    state?.state === AccountState.Initialized && !parsed.freezeAuthority
                        ? "SUPPORTED_WITH_VALIDATION"
                        : "CRITICAL_RISK";
                reason =
                    policy === "CRITICAL_RISK"
                        ? "New accounts can be frozen or are not initialized"
                        : "New accounts initialize unfrozen and freeze authority is absent";
            }
            else if (type === ExtensionType.MintCloseAuthority) {
                const authority = getMintCloseAuthority(parsed)?.closeAuthority;
                policy = authority?.equals(PublicKey.default)
                    ? "SUPPORTED_WITH_VALIDATION"
                    : "CRITICAL_RISK";
                reason =
                    policy === "CRITICAL_RISK"
                        ? "Active mint close authority"
                        : "Mint close authority is disabled";
            }
            else if (type === ExtensionType.PermanentDelegate) {
                const delegate = getPermanentDelegate(parsed)?.delegate;
                policy = delegate?.equals(PublicKey.default)
                    ? "SUPPORTED_WITH_VALIDATION"
                    : "CRITICAL_RISK";
                reason =
                    policy === "CRITICAL_RISK"
                        ? "Active permanent delegate can move or burn holder tokens"
                        : "Permanent delegate is disabled";
            }
            else if (type === ExtensionType.NonTransferable ||
                type === ExtensionType.PausableConfig ||
                type === ExtensionType.PermissionedBurn) {
                policy = "CRITICAL_RISK";
                reason = "Extension can prevent transfers or add token control";
            }
            else if (type === ExtensionType.TransferFeeConfig) {
                const fee = getTransferFeeConfig(parsed);
                details = fee
                    ? {
                        olderFeeBps: fee.olderTransferFee.transferFeeBasisPoints,
                        newerFeeBps: fee.newerTransferFee.transferFeeBasisPoints,
                        maximumFee: fee.newerTransferFee.maximumFee.toString(),
                    }
                    : undefined;
                reason =
                    "Transfer-fee withholding and future fee changes are not supported; skip rather than assume quoted output is spendable";
            }
            else if (type === ExtensionType.TransferHook)
                reason = "Additional transfer-hook program behavior is not supported";
            extensions.push({ typeId: type, type: name, policy, reason, details });
        }
        const unsupportedExtensions = extensions
            .filter((e) => e.policy === "UNSUPPORTED")
            .map((e) => e.type === "UNKNOWN" ? `UNKNOWN(typeId=${e.typeId})` : e.type);
        const criticalExtensions = extensions
            .filter((e) => e.policy === "CRITICAL_RISK")
            .map((e) => e.type);
        if (program === "TOKEN_2022" &&
            (parsed.mintAuthority || parsed.freezeAuthority))
            criticalExtensions.push(parsed.freezeAuthority
                ? "ACTIVE_FREEZE_AUTHORITY"
                : "ACTIVE_MINT_AUTHORITY");
        return {
            mint,
            tokenProgram: program,
            programId: info.owner.toBase58(),
            decimals: parsed.decimals,
            initialized: parsed.isInitialized,
            mintAuthority: parsed.mintAuthority?.toBase58() ?? null,
            freezeAuthority: parsed.freezeAuthority?.toBase58() ?? null,
            extensions,
            unsupportedExtensions,
            criticalExtensions,
            extensionRisk: criticalExtensions.length
                ? "CRITICAL"
                : unsupportedExtensions.length
                    ? "UNSUPPORTED"
                    : "LOW",
            decision: criticalExtensions.length || unsupportedExtensions.length
                ? "SKIP"
                : "ALLOW",
            at: Date.now(),
        };
    }
    catch (error) {
        if (error instanceof CandidateRejected)
            throw error;
        throw new CandidateRejected("INVALID_MINT_LAYOUT", { mint });
    }
}
export function requireCompatibleToken(report) {
    if (report.decision !== "ALLOW")
        throw new CandidateRejected(report.criticalExtensions.length
            ? "CRITICAL_TOKEN_EXTENSION"
            : "UNSUPPORTED_TOKEN_EXTENSION", { token: report });
}
export const tokenAccountAddress = (wallet, mint, program) => getAssociatedTokenAddressSync(mint, wallet, false, program);
export function inspectTokenAccount(address, info, wallet, mint, program) {
    if (!info)
        return 0n;
    if (!info.owner.equals(program))
        throw new Blocked("TOKEN_ACCOUNT_PROGRAM_MISMATCH");
    let account;
    try {
        account = unpackAccount(address, info, program);
    }
    catch {
        throw new CandidateRejected("INVALID_TOKEN_ACCOUNT_LAYOUT", {
            mint: mint.toBase58(),
        });
    }
    if (!account.owner.equals(wallet) || !account.mint.equals(mint))
        throw new Blocked("TOKEN_ACCOUNT_WALLET_OR_MINT_MISMATCH");
    if (account.delegate ||
        (account.closeAuthority && !account.closeAuthority.equals(wallet)))
        throw new Blocked("TOKEN_ACCOUNT_UNEXPECTED_AUTHORITY");
    if (!account.isInitialized || account.isFrozen)
        throw new CandidateRejected("TOKEN_SAFETY_FAILED", {
            reason: "Token account is uninitialized or frozen",
        });
    const extensions = getExtensionTypes(account.tlvData);
    if (extensions.some((e) => e !== ExtensionType.ImmutableOwner))
        throw new CandidateRejected("UNSUPPORTED_TOKEN_EXTENSION", {
            accountExtensions: extensions.map((e) => ({
                typeId: e,
                type: ExtensionType[e] ?? "UNKNOWN",
            })),
        });
    return account.amount;
}
