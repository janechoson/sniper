import { tokenQuantity } from "./dashboard-core.js";
export function setupPositionHelpers(ctx) {
  const post = ctx.post,
    error = ctx.error,
    showTrace = ctx.detail;
  // Positions is a presentation layer over existing confirmed accounting and exit API.
  window.BOTStructurePanel = (r, source, removable = false) => {
    const box = document.createElement("section");
    box.className = "structure-watch-panel structure-watch-row";
    const title = document.createElement("b");
    title.textContent = "";
    if (r?.mint) {
      title.textContent +=
        "" +
        (r.symbol ||
          (r.mint.length > 16
            ? r.mint.slice(0, 6) + "…" + r.mint.slice(-4)
            : r.mint));
      title.title = r.mint;
    }
    const head = document.createElement("div");
    head.className = "structure-row-head";
    head.append(title);
    box.append(head);
    if (!r) {
      const p = document.createElement("p");
      p.textContent = "Chưa qua thẩm định để bắt đầu theo dõi điểm vào.";
      box.append(p);
      return box;
    }
    const phases = {
      NEW: "Mới",
      INITIAL_EXPANSION: "Mở rộng ban đầu",
      PEAK_FORMING: "Đang hình thành đỉnh",
      WAITING_FOR_SELLING: "Chờ áp lực bán",
      SELLING_APPEARED: "Đã quan sát lực bán",
      ABSORPTION_FORMING: "Đang quan sát hấp thụ bán",
      ABSORPTION_DETECTED: "Đã quan sát hấp thụ — chờ lực đỡ",
      SEARCHING_FOR_SUPPORT: "Tìm vùng đỡ",
      SUPPORT_FORMING: "Đang hình thành lực đỡ",
      SUPPORT_FAILED: "Lực đỡ chưa giữ được — tiếp tục theo dõi",
      SUPPORT_CONFIRMED: "Đã xác nhận lực đỡ của bên mua",
      RECOVERY_ATTEMPT: "Đang thử phục hồi",
      RECOVERY_FAILED: "Phục hồi chưa thành — tiếp tục theo dõi",
      RECOVERY_CONFIRMED: "Đã xác nhận phục hồi",
      ENTRY_ELIGIBLE: "Đủ cấu trúc — vẫn cần phê duyệt mới",
    };
    const age = r.lastObservedAt
      ? Math.max(0, Math.floor((Date.now() - r.lastObservedAt) / 1000))
      : null;
    const elapsed = Math.max(
        0,
        Math.floor((Date.now() - r.structureWatchStartedAt) / 1000),
      ),
      limit = Math.floor(
        (r.structureWatchExpiresAt - r.structureWatchStartedAt) / 1000,
      );
    const time = (n) =>
      Math.floor(n / 60) + ":" + String(n % 60).padStart(2, "0");
    box.dataset.startedAt = String(r.structureWatchStartedAt);
    box.dataset.expiresAt = String(r.structureWatchExpiresAt);
    box.dataset.observedAt =
      r.lastObservedAt === undefined ? "" : String(r.lastObservedAt);
    box.dataset.quality = r.quality || "UNKNOWN";
    box.dataset.freshMs = String(r.dataFreshMs ?? 10000);
    const timer = document.createElement("span");
    timer.className = "structure-time";
    timer.textContent = `${time(Math.min(elapsed, limit))} / ${time(limit)}`;
    head.append(timer);
    if (removable) head.append(window.BOTRemovalMenu("watch", r));
    const line = document.createElement("div");
    line.className = "structure-row-phase";
    const phase = document.createElement("span");
    const evidenceCurrent =
      r.evidenceCurrent === true ||
      (r.evidenceCurrent === undefined &&
        r.evidenceVersion === "LOCAL_BUYER_DEFENSE_V2");
    phase.textContent = evidenceCurrent
      ? phases[r.phase] || "Chưa xác định"
      : "Bằng chứng cũ — cần thẩm định lại";
    if (r.evidence)
      phase.title = JSON.stringify({
        evidenceVersion: r.evidenceVersion,
        context: r.context,
        evidence: r.evidence,
      });
    const lock = document.createElement("span");
    lock.className = "structure-lock";
    lock.textContent =
      r.status === "PASSED" && evidenceCurrent
        ? "ĐỦ CẤU TRÚC"
        : r.recoveryGateMode === "TEMP_RECOVERY_BYPASS"
          ? "TEMP RECOVERY BYPASS"
          : ["EXPIRED", "USER_REMOVED"].includes(r.status)
            ? "ĐÃ DỪNG"
            : "ĐANG KHÓA";
    lock.title = "Đủ cấu trúc vẫn cần toàn bộ quy trình phê duyệt mua mới.";
    if (r.recoveryGateMode === "TEMP_RECOVERY_BYPASS")
      lock.title =
        "Tạm bỏ điều kiện Recovery Confirmed; evidence bên dưới giữ nguyên. Vẫn cần mọi kiểm tra an toàn trước BUY.";
    line.append(phase, lock);
    box.append(line);
    const progress = !evidenceCurrent
      ? {
          selling: "PENDING",
          absorption: "PENDING",
          support: "PENDING",
          recovery: "PENDING",
        }
      : r.progress || {
          selling: r.sellingSeen
            ? "COMPLETE"
            : r.sellingCount > 0
              ? "FORMING"
              : "PENDING",
          absorption: r.absorptionDetected
            ? "COMPLETE"
            : r.absorptionCount > 0
              ? "FORMING"
              : "PENDING",
          support: r.supportConfirmed
            ? "COMPLETE"
            : (r.supportCount ?? 0) > 0
              ? "FORMING"
              : "PENDING",
          recovery:
            r.status === "PASSED"
              ? "COMPLETE"
              : r.recoveryCount > 0
                ? "FORMING"
                : "PENDING",
        };
    const evidence = document.createElement("div");
    evidence.className = "structure-evidence";
    let complete = 0;
    for (const [key, label] of [
      ["selling", "Bán"],
      ["absorption", "Hấp thụ"],
      ["support", "Hỗ trợ"],
      ["recovery", "Phục hồi"],
    ]) {
      const state = progress[key] || "PENDING",
        chip = document.createElement("span");
      chip.textContent = `${label} ${state === "COMPLETE" ? "✓" : state === "FORMING" ? "◐" : "○"}`;
      chip.dataset.evidence = key;
      chip.dataset.state = state;
      evidence.append(chip);
      complete += state === "COMPLETE" ? 1 : state === "FORMING" ? 0.5 : 0;
    }
    const freshness = document.createElement("span");
    freshness.className = "structure-freshness";
    freshness.textContent = age === null ? "Chưa có dữ liệu" : `● ${age}s`;
    evidence.append(freshness);
    box.append(evidence);
    const rail = document.createElement("div");
    rail.className = "structure-evidence-rail";
    rail.title =
      "Tiến trình bằng chứng cấu trúc; không tính theo thời gian đã chờ.";
    const fill = document.createElement("i");
    fill.style.width = `${(complete / 4) * 100}%`;
    rail.append(fill);
    box.append(rail);
    box.dataset.tone =
      r.status === "INVALIDATED"
        ? "danger"
        : r.status === "EXPIRED"
          ? "muted"
          : !evidenceCurrent
            ? "neutral"
            : r.status === "PASSED"
              ? "success"
              : r.phase.includes("RECOVERY") && !r.phase.endsWith("FAILED")
                ? "positive"
                : r.phase.includes("SUPPORT")
                  ? "accent"
                  : "neutral";
    return box;
  };
  window.BOTRemovalPending ??= new Set();
  window.BOTRemovalMenu = (kind, r) => {
    const menu = document.createElement("details");
    menu.className = "row-menu";
    const summary = document.createElement("summary");
    summary.textContent = "⋮";
    summary.setAttribute("aria-label", "Thao tác");
    menu.append(summary);
    const choices = document.createElement("div");
    choices.className = "row-menu-choices";
    const detail = document.createElement("button");
    detail.textContent = "Chi tiết";
    detail.onclick = () => {
      menu.open = false;
      const panel =
        kind === "position"
          ? menu.closest(".position-card")?.querySelector(".position-details")
          : null;
      if (panel) {
        panel.open = true;
        panel.scrollIntoView({ block: "nearest" });
      } else void showTrace(r.mint).catch(error);
    };
    choices.append(detail);
    const button = document.createElement("button");
    button.textContent =
      kind === "position" ? "Xóa khỏi Position" : "Bỏ theo dõi";
    const key = kind + ":" + (r.id || r.mint);
    button.dataset.removeKey = key;
    const ineligible =
      kind === "position" &&
      (r.removalBlocked ??
        (r.state !== "OPEN" ||
          ["UNKNOWN", "EXIT_PENDING"].includes(r.displayState)));
    button.dataset.ineligible = String(ineligible);
    button.disabled = window.BOTRemovalPending.has(key) || ineligible;
    button.onclick = async () => {
      if (window.BOTRemovalPending.has(key)) return;
      window.BOTRemovalPending.add(key);
      button.disabled = true;
      menu.open = false;
      try {
        if (!(await window.BOTConfirmRemoval(kind, r))) return;
        await post(
          kind === "position" ? "/api/positions/dismiss" : "/api/watch/dismiss",
          kind === "position" ? { positionId: r.id } : { mint: r.mint },
        );
        if (ctx.active()) await ctx.refresh();
      } catch (e) {
        error(e);
      } finally {
        window.BOTRemovalPending.delete(key);
        for (const b of ctx.active()
          ? document.querySelectorAll("[data-remove-key]")
          : [])
          if (b.dataset.removeKey === key)
            b.disabled = b.dataset.ineligible === "true";
      }
    };
    choices.append(button);
    menu.append(choices);
    return menu;
  };
  window.BOTConfirmRemoval = (kind, r) =>
    new Promise((resolve) => {
      const existing = document.getElementById("removeConfirm");
      if (existing?.open) {
        resolve(false);
        return;
      }
      const dialog = existing || document.createElement("dialog");
      dialog.id = "removeConfirm";
      const title = document.createElement("h2");
      title.textContent =
        kind === "position" ? "Xóa khỏi Position?" : "Bỏ theo dõi token?";
      const token = document.createElement("p");
      token.textContent = `Token: ${r.symbol || "—"}\nMint: ${r.mint}`;
      const note = document.createElement("p");
      note.textContent =
        kind === "position"
          ? "BOT sẽ ngừng quản lý Position này. Thao tác này KHÔNG bán token trên blockchain. Token có thể vẫn còn trong ví."
          : "BOT sẽ ngừng theo dõi cơ hội Sniper này. Phân tích chưa ký không còn quyền mua; giao dịch đã gửi vẫn được đối soát.";
      const quantity =
        kind === "position" &&
        r.quantity !== undefined &&
        r.decimals !== undefined
          ? document.createElement("p")
          : null;
      if (quantity)
        quantity.textContent = `Số lượng BOT ghi nhận: ${tokenQuantity(r.quantity, r.decimals)} ${r.symbol || ""}`;
      const controls = document.createElement("div");
      controls.className = "remove-confirm-actions";
      const cancel = document.createElement("button");
      cancel.textContent = "Hủy";
      const accept = document.createElement("button");
      accept.textContent =
        kind === "position" ? "Xóa khỏi Position" : "Bỏ theo dõi";
      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        dialog.close();
        resolve(value);
      };
      cancel.onclick = () => finish(false);
      accept.onclick = () => finish(true);
      dialog.oncancel = (event) => {
        event.preventDefault();
        finish(false);
      };
      dialog.onclose = () => finish(false);
      controls.append(cancel, accept);
      dialog.replaceChildren(
        title,
        token,
        note,
        ...(quantity ? [quantity] : []),
        controls,
      );
      if (!existing) document.body.append(dialog);
      dialog.showModal();
      cancel.focus();
    });
  window.BOTWatchTick = () => {
    const time = (n) =>
      Math.floor(n / 60) + ":" + String(n % 60).padStart(2, "0");
    for (const row of document.querySelectorAll(
      ".structure-watch-row[data-started-at]",
    )) {
      const start = Number(row.dataset.startedAt),
        end = Number(row.dataset.expiresAt),
        observed =
          row.dataset.observedAt === "" ? null : Number(row.dataset.observedAt);
      const elapsed = Math.max(0, Math.floor((Date.now() - start) / 1000)),
        limit = Math.max(0, Math.floor((end - start) / 1000));
      row.querySelector(".structure-time").textContent =
        `${time(Math.min(elapsed, limit))} / ${time(limit)}`;
      const age =
        observed === null
          ? null
          : Math.max(0, Math.floor((Date.now() - observed) / 1000));
      const stale =
        age !== null &&
        (Date.now() - observed > Number(row.dataset.freshMs) ||
          row.dataset.quality !== "FRESH");
      row.querySelector(".structure-freshness").textContent =
        age === null
          ? "Chưa có dữ liệu"
          : stale
            ? `Cũ · ${age >= 60 ? Math.floor(age / 60) + "m" + (age % 60) + "s" : age + "s"}`
            : `● ${age}s`;
      row.classList.toggle("is-stale", stale || age === null);
    }
  };
  window.BOTExitPanel = (report, quantity) => {
    const box = document.createElement("section");
    box.className = "exit-liquidity-panel";
    const title = document.createElement("b");
    title.textContent =
      report?.purpose === "PRE_BUY"
        ? "KHẢ NĂNG THOÁT TRƯỚC MUA"
        : "ƯỚC TÍNH THANH KHOẢN THOÁT";
    box.append(title);
    if (!report) {
      const p = document.createElement("p");
      p.textContent = "Chưa kiểm tra — chưa có ước tính SELL thực thi.";
      box.append(p);
      return box;
    }
    const stale =
      (quantity !== undefined && report.quantity !== quantity) ||
      Date.now() >
        (report.validUntil ??
          report.checkedAt + (report.purpose === "PRE_BUY" ? 15000 : 600000));
    box.dataset.expiresAt = String(
      report.validUntil ??
        report.checkedAt + (report.purpose === "PRE_BUY" ? 15000 : 600000),
    );
    const names = {
      HEALTHY: "ĐỦ BIÊN PHÍ",
      LIMITED: "HẠN CHẾ",
      POOR: "QUÁ MỎNG",
      NO_EXIT: "CHƯA CÓ TUYẾN",
      THIN: "MỎNG",
      NO_ROUTE: "KHÔNG CÓ TUYẾN",
      UNKNOWN: "CHƯA RÕ",
    };
    const rows = document.createElement("div");
    rows.className = "exit-levels";
    for (const l of report.levels ?? []) {
      const row = document.createElement("span");
      row.dataset.exitLevel = String(l.sellBps);
      row.className = l.economicallyMeaningful ? "positive" : "muted";
      row.textContent = `${l.sellBps / 100}% · ${stale ? "DỮ LIỆU CŨ" : (names[l.status] ?? "CHƯA RÕ")}`;
      row.title = l.minimumSolOut
        ? `SOL tối thiểu theo quote: ${Number(l.minimumSolOut) / 1e9}; sau ngân sách phí: ${Number(l.netMinimumLamports) / 1e9}`
        : "Chưa có output xác minh";
      rows.append(row);
    }
    box.append(rows);
    const full = report.levels?.find((l) => l.sellBps === 10000);
    if (full?.netMinimumLamports !== undefined) {
      const value = document.createElement("small");
      value.textContent = `Ước tính 100% sau ngân sách phí: ${(Number(full.netMinimumLamports) / 1e9).toFixed(9)} SOL`;
      box.append(value);
    }
    const age = document.createElement("small");
    age.className = "exit-estimate-age";
    age.textContent = stale ? "Ước tính đã cũ" : "";
    box.append(age);
    const note = document.createElement("small");
    note.textContent = `${names[report.status] ?? "CHƯA RÕ"} · Kiểm tra ${new Date(report.checkedAt).toLocaleTimeString("vi-VN")} · Quote chưa ký, không bảo đảm khả năng bán về sau. Định giá GMGN trên card là giá trị thị trường, không phải SOL bảo đảm bán được.`;
    box.append(note);
    return box;
  };

  ctx.onDispose(() => {
    const modal = document.getElementById("removeConfirm");
    if (modal?.open) modal.close();
    modal?.remove();
    for (const name of [
      "BOTStructurePanel",
      "BOTRemovalMenu",
      "BOTConfirmRemoval",
      "BOTWatchTick",
      "BOTExitPanel",
    ])
      window[name] = undefined;
  });
}
