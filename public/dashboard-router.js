const $ = (id) => document.getElementById(id);
const routes = {
  "/": { view: "overview", module: "overview", title: "Luồng xử lý token" },
  "/positions": { view: "positions", module: "positions", title: "Vị thế" },
  "/history": {
    view: "history",
    module: "history",
    title: "Lịch sử giao dịch",
  },
  "/memory": { view: "learning", module: "memory", title: "Bộ nhớ giao dịch" },
  "/settings": { view: "settings", module: "settings", title: "Cấu hình" },
  "/logs": { view: "logs", module: "logs", title: "Log" },
  "/thongke": { view: "statistics", module: "statistics", title: "Thống kê" },
  "/watchlist": {
    view: "watchlist",
    module: "watch",
    title: "Theo dõi điểm vào",
  },
  "/deferred": { view: "deferred", module: "watch", title: "Tạm hoãn" },
};
let shell,
  shellPromise,
  badgePromise,
  badgeLoaded = false,
  legacyBadgeFromPage = false,
  badgeController,
  routeEpoch = 0,
  current;
const shellListeners = new Set();
const abortError = () => new DOMException("Route left", "AbortError");
function renderPositionCount(count) {
  if (!Number.isInteger(count) || count < 0)
    throw Error("Invalid position count");
  const badge = $("positionsBadge");
  badge.textContent = String(count);
  badge.classList.toggle("hidden", count === 0);
  badge.classList.remove("attention");
  badge.setAttribute("aria-label", count + " vị thế đang hiển thị");
}
async function refreshBadge() {
  // Compatibility while the old backend is still running during deployment.
  if (!shell?.capabilities?.positionBadgeCount) return;
  if (!badgePromise) {
    badgeController = new AbortController();
    badgePromise = fetch("/api/positions/count", {
      cache: "no-store",
      signal: badgeController.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw Error("Không lấy được số lượng vị thế");
        const data = await response.json();
        renderPositionCount(data.count);
        badgeLoaded = true;
      })
      .finally(() => {
        badgePromise = undefined;
      });
  }
  return badgePromise;
}
function notice(error) {
  if (error?.name !== "AbortError") $("notice").textContent = error.message;
}
function renderShell(s) {
  shell = s;
  $("mode").textContent = window.BOTText.vi(s.mode.toUpperCase());
  $("overviewMode").textContent = s.mode.toUpperCase();
  $("terminalBalance").textContent =
    s.balanceLamports === null
      ? "SOL: N/A"
      : "SOL: " +
        (Number(s.balanceLamports) / 1e9).toLocaleString("en-US", {
          maximumFractionDigits: 8,
        });
  const price = Number(s.solPriceUsd);
  $("terminalUsd").textContent =
    price > 0 &&
    s.balanceLamports !== null &&
    Number.isFinite(s.solPriceUpdatedAt) &&
    s.solPriceUpdatedAt <= Date.now() &&
    Date.now() - s.solPriceUpdatedAt < 60000
      ? "(~$" +
        ((Number(s.balanceLamports) / 1e9) * price).toLocaleString("en-US", {
          maximumFractionDigits: 2,
        }) +
        ")"
      : "USD: N/A";
  $("terminalRunning").textContent = s.scanner.running
    ? "Bot Running"
    : "Bot Stopped";
  $("terminalDot").classList.toggle("running", !!s.scanner.running);
  $("scanner").textContent = s.scanner.running
    ? "Bộ quét đang chạy"
    : "Bộ quét đã dừng";
  if (s.capabilities?.positionBadgeCount) {
    if (!badgeLoaded) void refreshBadge().catch(notice);
  } else if (s.positionSummary && !legacyBadgeFromPage)
    renderPositionCount(s.positionSummary.count);
  $("notice").textContent = s.haltReason
    ? "TẠM DỪNG MUA MỚI · " + s.haltReason
    : s.mode === "paper"
      ? "PAPER · Chỉ giao dịch mô phỏng"
      : s.newEntriesEnabled
        ? "LIVE · Thực thi theo quyết định và các kiểm tra hiện hành"
        : "LIVE · Mua mới đã tắt; vẫn quản lý vị thế";
  $("notice").classList.toggle("system-pause", !!s.haltReason);
  for (const listener of shellListeners) listener(s);
}
async function refreshShell(force = false) {
  if (force && shellPromise) await shellPromise.catch(() => {});
  if (!shellPromise)
    shellPromise = fetch("/api/ui/shell", { cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) throw Error("Không lấy được trạng thái runtime");
        const data = await r.json();
        renderShell(data);
        return data;
      })
      .finally(() => {
        shellPromise = undefined;
      });
  return shellPromise;
}
function createScope(epoch) {
  const controller = new AbortController(),
    reads = new Map(),
    timeouts = new Set(),
    intervals = new Set(),
    disposals = [],
    urls = new Set();
  let refresh = async () => {};
  const active = () => epoch === routeEpoch && !controller.signal.aborted;
  const ctx = {
    routeKey: location.pathname + location.search,
    active,
    shell: () => shell,
    legacyPositionCount(count) {
      // Use already visible page data until the count-capable backend is loaded.
      if (!shell?.capabilities?.positionBadgeCount && active()) {
        legacyBadgeFromPage = true;
        renderPositionCount(count);
      }
    },
    signal: controller.signal,
    error: (error) => {
      if (active()) notice(error);
    },
    async detail(mint) {
      const [rows, candidate] = await Promise.all([
        ctx.get("/api/trace?mint=" + encodeURIComponent(mint)),
        ctx
          .get("/api/candidate?mint=" + encodeURIComponent(mint))
          .catch(() => null),
      ]);
      if (!active()) return;
      $("trace").replaceChildren();
      for (const [label, value] of [
        ["Candidate", candidate],
        ...rows.map((r) => [r.kind, r.payload]),
      ]) {
        const section = document.createElement("section"),
          heading = document.createElement("h3"),
          body = document.createElement("pre");
        heading.textContent = label;
        body.textContent = JSON.stringify(value, null, 2);
        section.append(heading, body);
        $("trace").append(section);
      }
      $("detail").showModal();
    },
    async get(path, requestKey) {
      if (!active()) throw abortError();
      const key = requestKey ?? path.split("?")[0];
      reads.get(key)?.abort();
      const pending = new AbortController();
      reads.set(key, pending);
      const abort = () => pending.abort();
      controller.signal.addEventListener("abort", abort, { once: true });
      try {
        const response = await fetch(path, {
          signal: pending.signal,
          cache: "no-store",
        });
        if (!response.ok)
          throw Error((await response.json()).error || "Local request failed");
        const value = await response.json();
        if (!active() || pending.signal.aborted) throw abortError();
        return value;
      } finally {
        controller.signal.removeEventListener("abort", abort);
        if (reads.get(key) === pending) reads.delete(key);
      }
    },
    async post(path, value, { refreshGlobal = true } = {}) {
      if (!active()) throw abortError();
      // A sent operator command is not cancelled by navigation. Its UI response is route-bound.
      const response = await fetch(path, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": shell.csrf,
        },
        body: JSON.stringify(value),
      });
      const data = await response.json();
      if (!response.ok) throw Error(data.error || "Request failed");
      if (refreshGlobal) {
        await refreshShell(true);
        await refreshBadge();
      }
      return data;
    },
    timeout(fn, delay) {
      const id = setTimeout(() => {
        timeouts.delete(id);
        if (active()) fn();
      }, delay);
      timeouts.add(id);
      return id;
    },
    interval(fn, delay) {
      const id = setInterval(() => {
        if (active()) fn();
      }, delay);
      intervals.add(id);
      return id;
    },
    onDispose(fn) {
      disposals.push(fn);
    },
    trackObjectUrl(url) {
      urls.add(url);
    },
    onShell(fn) {
      const bound = (value) => {
        if (active()) fn(value);
      };
      shellListeners.add(bound);
      disposals.push(() => shellListeners.delete(bound));
    },
    setRefresh(fn) {
      refresh = fn;
    },
    async refresh() {
      if (!active()) return;
      try {
        await refresh();
      } catch (error) {
        ctx.error(error);
      }
    },
    async poll(work, delay) {
      const loop = async () => {
        if (!active()) return;
        try {
          await work();
        } catch (error) {
          ctx.error(error);
        } finally {
          if (active()) ctx.timeout(loop, delay);
        }
      };
      await loop();
    },
    query(values) {
      const url = new URL(location.href);
      for (const [key, value] of Object.entries(values)) {
        if (value === null) url.searchParams.delete(key);
        else url.searchParams.set(key, value);
      }
      history.replaceState(null, "", url);
      ctx.routeKey = url.pathname + url.search;
    },
    dispose() {
      controller.abort();
      for (const pending of reads.values()) pending.abort();
      for (const id of timeouts) clearTimeout(id);
      for (const id of intervals) clearInterval(id);
      for (const dispose of disposals.reverse()) dispose();
      for (const url of urls) URL.revokeObjectURL(url);
    },
  };
  return ctx;
}
async function navigate(value, { replace = false, pop = false } = {}) {
  const url = new URL(value, location.origin);
  if (url.origin !== location.origin) {
    location.assign(url);
    return;
  }
  if (current?.active() && current.routeKey === url.pathname + url.search) {
    if (!pop) {
      if (replace) history.replaceState(null, "", url);
      else if (url.href !== location.href) history.pushState(null, "", url);
    }
    if (url.hash) document.getElementById(url.hash.slice(1))?.scrollIntoView();
    return;
  }
  if (!pop) {
    if (replace) history.replaceState(null, "", url);
    else history.pushState(null, "", url);
  }
  const epoch = ++routeEpoch;
  current?.dispose();
  current = undefined;
  const modal = $("detail");
  if (modal.open) modal.close();
  $("trace").replaceChildren();
  $("routeOutlet").replaceChildren();
  $("routeOutlet").dataset.state = "loading";
  const route = routes[url.pathname];
  for (const item of document.querySelectorAll("a[data-route]")) {
    const selected = new URL(item.href).pathname === url.pathname;
    item.classList.toggle("active", selected);
    if (selected) item.setAttribute("aria-current", "page");
    else item.removeAttribute("aria-current");
  }
  if (!route) {
    $("title").textContent = "404";
    const heading = document.createElement("h2");
    heading.textContent = "404 · Không có trang này";
    $("routeOutlet").append(heading);
    return;
  }
  $("title").textContent = route.title;
  try {
    const [module] = await Promise.all([
      import("/dashboard-" + route.module + ".js"),
      shell ? Promise.resolve(shell) : refreshShell(),
    ]);
    if (epoch !== routeEpoch) return;
    const template = $("page-" + route.view);
    $("routeOutlet").append(template.content.cloneNode(true));
    current = createScope(epoch);
    await module.mount(current, route.view);
    if (epoch === routeEpoch) {
      $("routeOutlet").dataset.state = "ready";
      $("routeOutlet").dataset.route = url.pathname;
    }
    if (epoch === routeEpoch && url.hash)
      document.getElementById(url.hash.slice(1))?.scrollIntoView();
  } catch (error) {
    if (epoch === routeEpoch) notice(error);
  }
}
document.addEventListener("click", (event) => {
  const link = event.target.closest("a[data-route]");
  if (
    link &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey &&
    event.button === 0
  ) {
    event.preventDefault();
    void navigate(link.href);
    return;
  }
  const open = event.target.closest("[data-open-view]");
  if (open) {
    const entry = Object.entries(routes).find(
      ([, r]) => r.view === open.dataset.openView,
    );
    if (entry) void navigate(entry[0]);
  }
  const scroll = event.target.closest("[data-scroll-target]");
  if (scroll) void navigate("/#" + scroll.dataset.scrollTarget);
});
window.addEventListener(
  "popstate",
  () => void navigate(location.href, { pop: true }),
);
$("closeDetail").onclick = () => $("detail").close();
let shellTimer, badgeTimer, clockTimer;
function startShellTimers() {
  shellTimer = setInterval(() => void refreshShell().catch(notice), 5000);
  badgeTimer = setInterval(() => void refreshBadge().catch(notice), 5000);
  clockTimer = setInterval(() => {
    $("clock").textContent = new Date().toLocaleTimeString("vi-VN");
  }, 1000);
}
startShellTimers();
window.addEventListener("pagehide", () => {
  current?.dispose();
  clearInterval(shellTimer);
  clearInterval(badgeTimer);
  badgeController?.abort();
  clearInterval(clockTimer);
});
window.addEventListener("pageshow", (event) => {
  if (event.persisted) {
    startShellTimers();
    void refreshShell().catch(notice);
    void refreshBadge().catch(notice);
    void navigate(location.href, { pop: true });
  }
});
window.BOTDashboard = { navigate };
void navigate(location.href, { replace: true });
