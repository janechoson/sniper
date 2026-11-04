/** Public display metadata only; never participates in trading qualification. */
export const TOKEN_IMAGE_CSP = "'self' https://gmgn.ai/external-res/ https://pump.mypinata.cloud/ipfs/";
export function normalizeTokenLogo(value) {
    if (typeof value !== "string" || !value.trim() || value.length > 4096)
        return null;
    try {
        const url = new URL(value.trim());
        if (url.protocol !== "https:" || url.username || url.password)
            return null;
        if (!((url.origin === "https://gmgn.ai" &&
            url.pathname.startsWith("/external-res/")) ||
            (url.origin === "https://pump.mypinata.cloud" &&
                url.pathname.startsWith("/ipfs/"))))
            return null;
        return url.href;
    }
    catch {
        return null;
    }
}
export function tokenLogo(value) {
    if (!value || typeof value !== "object")
        return null;
    const t = value;
    return normalizeTokenLogo(t.logo) ?? normalizeTokenLogo(t.listing?.logo);
}
export function withTokenLogo(value) {
    return { ...value, logo: tokenLogo(value) };
}
