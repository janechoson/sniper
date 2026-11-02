/* One avatar renderer for every token identity. No HTML strings or URL synthesis. */
(() => {
  const metadata = new Map();
  function normalize(value) {
    if (typeof value !== "string" || !value.trim() || value.length > 4096)
      return null;
    try {
      const u = new URL(value.trim());
      if (u.protocol !== "https:" || u.username || u.password) return null;
      return (u.origin === "https://gmgn.ai" &&
        u.pathname.startsWith("/external-res/")) ||
        (u.origin === "https://pump.mypinata.cloud" &&
          u.pathname.startsWith("/ipfs/"))
        ? u.href
        : null;
    } catch {
      return null;
    }
  }
  function direct(token) {
    return normalize(token?.logo) ?? normalize(token?.listing?.logo);
  }
  function remember(tokens) {
    for (const t of tokens || [])
      if (t?.mint) {
        const old = metadata.get(t.mint) || {};
        metadata.set(t.mint, {
          ...old,
          ...t,
          logo: direct(t) ?? old.logo ?? null,
        });
      }
    while (metadata.size > 2000) metadata.delete(metadata.keys().next().value);
  }
  function logo(token) {
    return direct(token) ?? metadata.get(token?.mint)?.logo ?? null;
  }
  function create(token = {}, className = "token-avatar", initials) {
    token = token || {};
    const known = metadata.get(token.mint) || {};
    const label =
      token.symbol ||
      known.symbol ||
      token.name ||
      known.name ||
      "Unknown Token";
    const wrapper = document.createElement("span");
    wrapper.className = className + " token-image-avatar";
    const fallback = document.createElement("span");
    fallback.className = "token-initials";
    fallback.textContent =
      initials ??
      (label === "Unknown Token" ? "?" : label.slice(0, 2).toUpperCase());
    wrapper.append(fallback);
    const src = logo(token);
    if (src) {
      const img = document.createElement("img");
      img.className = "token-logo";
      img.alt = label;
      img.decoding = "async";
      img.referrerPolicy = "no-referrer";
      img.addEventListener("load", () => {
        fallback.hidden = true;
        img.hidden = false;
        wrapper.dataset.logoState = "loaded";
      });
      img.addEventListener("error", () => {
        img.hidden = true;
        img.remove();
        fallback.hidden = false;
        wrapper.dataset.logoState = "fallback";
      });
      img.hidden = true;
      wrapper.dataset.logoState = "loading";
      wrapper.append(img);
      img.src = src;
    } else wrapper.dataset.logoState = "fallback";
    return wrapper;
  }
  window.BOTTokenAvatar = { create, remember, logo, normalize };
})();
