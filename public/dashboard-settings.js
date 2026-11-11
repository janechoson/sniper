import { el } from "./dashboard-core.js";

// UI-only exclusions for the normal TRENDING_ONE_SHOT_V1 path.
// Keep schema/persisted values for historical readers and operator compatibility.
export const obsoleteSettingsFields = new Set([
  "maxAgeSeconds", // SNIPER age branch; normal Trending uses trendingMaxAgeSeconds.
  "analysisRefreshMs", // No runtime consumer.
  "structureWatchTtlMs",
  "structureWatchMaxSize",
  "structureObservationMs",
  "structureConfirmations", // Legacy sequential Watch; oneShotStructure does not use them.
  "sniperPollMs", // Disabled source's feed cache/cadence only.
  "trendingPriorityBoost",
  "multiSourcePriorityBoost", // Legacy discoveryBoost/Watch path.
  "candidateAgingPointsPerMinute",
  "sniperMaxWaitMs",
  "sniperWatchReserve",
  "trendingAnalysisBurst",
  "queueReplacementMargin", // Retired priority scheduler.
  "watchMaxSize",
  "watchRecheckMs",
  "deferredMaxSize",
  "deferredTtlMs",
  "deferredRecheckMs",
  "deferredMaxRechecks", // Retired candidate retry lists.
]);

// Operator-requested UI exclusions. These settings remain active in the backend
// and are preserved by the settingsData copy when other fields are saved.
const hiddenSettingsFields = new Set([
  "tokenFailureThreshold",
  "recentRejectTtlMs",
  "flowMaxTransitions",
  "flowObservationIntervalMs",
  "flowRegimeConfirmations",
  "exitProbeMaxImpactPercent",
  "positionRecheckMs",
  "gmgnQueueMaxSize",
  "exitProbeEntryBps",
  "positionExitProbeMs",
  "positionExitProbeSpacingMs",
  "exitProbeMaxAgeMs",
  "structureMaxGapMs",
  "intelligenceCacheMs",
  "trailingStopBps",
  "gmgnBackoffMaxMs",
  "trendingInterval",
  "maxDecisionPriceMovePercent",
  "trailingActivationBps",
  "gmgnBackoffBaseMs",
  "trendingPollMs",
  "flowMaxObservations",
  "flowMinSpanMs",
  "flowHistoryMs",
  "flowMeaningfulChangePercent",
  "trendingFreshMs",
  "candidateQueueSize",
  "paperFeeLamports",
  "exitProbeMinNetLamports",
  "flowStaleMs",
  "liquidityCollapseBps",
  "maxSnapshotAgeMs",
  "criticalRugRatio",
  "exitProbeFeeBudgetLamports",
  "flowMinObservations",
  "feeReserveLamports",
  "warningRugRatio",
  "gmgnRequestIntervalMs",
]);

const settingsGroups = [
  {
    id: "sizing",
    title: "Quy mô lệnh & vốn",
    fields: [
      "positionSizeMode",
      "positionSizePercent",
      "positionSizeSol",
      "slippagePercent",
    ],
  },
  {
    id: "risk",
    title: "Rủi ro & bảo mật",
    fields: [
      "minLiquidityUsd",
      "maxTop1Percent",
      "maxTop10Percent",
      "maxCreatorPercent",
      "maxTaxPercent",
    ],
  },
  {
    id: "discovery",
    title: "Nguồn token & xử lý",
    fields: [
      "trendingMaxAgeSeconds",
      "trendingLimit",
      "candidatesPerCycle",
      "gmgnReadConcurrency",
      "positionCollectorConcurrency",
    ],
  },
  {
    id: "exits",
    title: "Thoát lệnh",
    fields: ["smartMoneyExitMode", "exitExecutionsPerCycle"],
  },
];

export async function mount(ctx) {
  const $ = (id) => document.getElementById(id),
    post = ctx.post;
  let statusData = ctx.shell(),
    settingsData,
    editing = false,
    saving = false,
    entryControlPending = false,
    toastVersion = 0;
  const showToast = (kind, message) => {
    const version = ++toastVersion,
      toast = $("settingsToast");
    toast.dataset.kind = kind;
    toast.hidden = false;
    toast.setAttribute("role", kind === "error" ? "alert" : "status");
    toast.setAttribute("aria-live", kind === "error" ? "assertive" : "polite");
    $("settingsToastMessage").textContent = message;
    $("saved").textContent = message;
    if (kind === "success")
      ctx.timeout(() => {
        if (version === toastVersion) toast.hidden = true;
      }, 6000);
  };
  $("settingsToastClose").onclick = () => {
    $("settingsToast").hidden = true;
    toastVersion++;
  };
  function updateSizeControls() {
    const mode = $("setting-positionSizeMode"),
      percent = $("setting-positionSizePercent"),
      sol = $("setting-positionSizeSol"),
      fixedSupported = !!statusData?.capabilities?.fixedSolPositionSize;
    if (mode) mode.disabled = !fixedSupported;
    const hint = $("positionSizeModeHint");
    if (hint)
      hint.textContent = fixedSupported
        ? ""
        : "Backend đang chạy chưa hỗ trợ mode SOL cố định. Cần nạp backend mới để sử dụng; mode % hiện tại vẫn hoạt động.";
    if (percent)
      percent.disabled =
        !statusData?.capabilities?.configurablePositionSize ||
        mode?.value === "SOL";
    if (sol) sol.disabled = !fixedSupported || mode?.value !== "SOL";
  }
  function renderSettings(settings) {
    // Keep the sizing controls visible on an older running backend as well.
    // Display-only defaults are never added to that backend's save payload.
    const displayed = {
      positionSizeMode: settings.positionSizeMode ?? "PERCENT",
      positionSizePercent: settings.positionSizePercent,
      positionSizeSol: settings.positionSizeSol ?? 0.2,
      ...settings,
    };
    const fields = new Map(
      Object.entries(displayed)
        .filter(
          ([key]) =>
            key !== "takeProfits" &&
            key !== "stopLossBps" &&
            !obsoleteSettingsFields.has(key) &&
            !hiddenSettingsFields.has(key),
        )
        .map(([key, value]) => {
          const d = el("div", undefined, "setting-field");
          const label = el(
            "label",
            {
              positionSizeMode: "Chế độ quy mô lệnh mua",
              positionSizePercent: "Quy mô lệnh mua (%)",
              positionSizeSol: "Số SOL cố định mỗi lệnh mua",
              tokenFailureThreshold: "Số lần lỗi Position trước backoff dài",
              recentRejectTtlMs: "Backoff dài khi Position gặp lỗi (ms)",
            }[key] || key,
          );
          label.htmlFor = "setting-" + key;
          d.append(label);
          if (key === "positionSizeMode") {
            const hint = el("small");
            hint.id = "positionSizeModeHint";
            d.append(hint);
          }
          if (key === "recentRejectTtlMs" || key === "tokenFailureThreshold")
            d.append(
              el(
                "small",
                "Đang dùng cho backoff khi theo dõi Position gặp lỗi.",
              ),
            );
          let input;
          if (
            typeof value === "boolean" ||
            key === "smartMoneyExitMode" ||
            key === "positionSizeMode" ||
            key === "trendingInterval"
          ) {
            input = el("select");
            const options =
              typeof value === "boolean"
                ? ["true", "false"]
                : key === "trendingInterval"
                  ? ["1m", "5m", "1h", "6h", "24h"]
                  : ["OFF", "WARNING", "EXIT"];
            const choices =
              key === "positionSizeMode" ? ["PERCENT", "SOL"] : options;
            choices.forEach((v) => {
              const o = el(
                "option",
                key === "positionSizeMode"
                  ? v === "SOL"
                    ? "SOL cố định"
                    : "% tài khoản"
                  : v,
              );
              o.value = v;
              input.append(o);
            });
            input.value = String(value);
            if (key === "positionSizeMode") input.onchange = updateSizeControls;
          } else {
            input = el("input");
            input.value = Array.isArray(value) ? JSON.stringify(value) : value;
            input.type =
              typeof value === "number" ||
              (typeof value === "string" && /^\d+$/.test(value))
                ? "number"
                : "text";
            input.min = "0";
            input.step = Number.isInteger(Number(value)) ? "1" : "any";
            if (key === "positionSizePercent") {
              input.min = "0.01";
              input.max = "100";
              input.step = "0.01";
              input.readOnly =
                !statusData?.capabilities?.configurablePositionSize;
              d.append(
                el(
                  "small",
                  input.readOnly
                    ? "Cần nạp backend mới để thay đổi quy mô lệnh."
                    : "Tính trên SOL khả dụng sau khi trừ phí dự phòng và vốn đang giữ chỗ.",
                ),
              );
            }
            if (key === "positionSizeSol") {
              input.min = "0.000000001";
              input.step = "0.000000001";
              input.inputMode = "decimal";
              d.append(
                el(
                  "small",
                  "Chỉ dùng ở mode SOL cố định. Mặc định 0.2 SOL; thiếu vốn thì chặn lệnh, không tự giảm số SOL.",
                ),
              );
            }
          }
          input.name = key;
          input.id = "setting-" + key;
          d.append(input);
          // Descriptions belong below the control, so they cannot shift its baseline.
          for (const note of d.querySelectorAll("small")) d.append(note);
          return [key, d];
        }),
    );
    const groups = [];
    const addGroup = (id, title, keys) => {
      const controls = keys.flatMap((key) => {
        const control = fields.get(key);
        if (!control) return [];
        fields.delete(key);
        return [control];
      });
      if (!controls.length) return;
      const section = el("section", undefined, "settings-group"),
        heading = el("h3", title, "settings-group-title"),
        grid = el("div", undefined, "settings-group-grid");
      section.dataset.group = id;
      heading.id = "settings-group-" + id;
      section.setAttribute("aria-labelledby", heading.id);
      grid.append(...controls);
      section.append(heading, grid);
      groups.push(section);
    };
    for (const group of settingsGroups)
      addGroup(group.id, group.title, group.fields);
    addGroup("other", "Cấu hình khác", [...fields.keys()]);
    $("settingFields").replaceChildren(...groups);
    updateSizeControls();
  }

  const refresh = async () => {
    settingsData = await ctx.get("/api/settings");
    if (!editing) renderSettings(settingsData);
  };
  ctx.setRefresh(refresh);
  function renderBuyPermission(enabled) {
    $("kill").checked = enabled === true;
    $("buyPermissionState").textContent = enabled === true ? "ON" : "OFF";
  }
  ctx.onShell((s) => {
    statusData = s;
    if (!entryControlPending) renderBuyPermission(s.newEntriesEnabled);
    updateSizeControls();
  });
  renderBuyPermission(statusData.newEntriesEnabled);
  $("kill").onchange = async (event) => {
    if (entryControlPending) return;
    const enabled = event.target.checked;
    entryControlPending = true;
    $("kill").disabled = true;
    $("kill").setAttribute("aria-busy", "true");
    renderBuyPermission(enabled);
    try {
      const result = await post(
        "/api/kill",
        { enabled },
        { refreshGlobal: false },
      );
      if (!ctx.active()) return;
      if (result?.ok !== true) throw Error("API chưa xác nhận thay đổi.");
      statusData = { ...statusData, newEntriesEnabled: enabled };
      renderBuyPermission(enabled);
      showToast(
        "success",
        enabled ? "Đã bật cho phép mua." : "Đã tắt cho phép mua.",
      );
    } catch (e) {
      if (!ctx.active()) return;
      renderBuyPermission(statusData.newEntriesEnabled);
      showToast(
        "error",
        "Không thay đổi được quyền mua: " +
          (e.message || "Không kết nối được API."),
      );
    } finally {
      entryControlPending = false;
      if (ctx.active()) {
        $("kill").disabled = false;
        $("kill").removeAttribute("aria-busy");
      }
    }
  };
  $("settingsForm").oninput = () => {
    editing = true;
    $("saved").textContent = "";
  };
  $("settingsForm").onsubmit = async (e) => {
    e.preventDefault();
    if (saving || !settingsData) return;
    saving = true;
    $("settingsControls").disabled = true;
    $("settingsForm").setAttribute("aria-busy", "true");
    const submit = $("settingsForm").querySelector('button[type="submit"]');
    submit.textContent = "Đang lưu…";
    try {
      const settings = { ...settingsData };
      document
        .querySelectorAll("#settingFields input,#settingFields select")
        .forEach((i) => {
          if (!Object.hasOwn(settings, i.name)) return;
          settings[i.name] = Array.isArray(settings[i.name])
            ? JSON.parse(i.value)
            : typeof settings[i.name] === "boolean"
              ? i.value === "true"
              : typeof settings[i.name] === "string"
                ? i.value
                : Number(i.value);
        });
      const result = await post("/api/settings", settings, {
        refreshGlobal: false,
      });
      if (!ctx.active()) return;
      if (result?.ok !== true) throw Error("API chưa xác nhận lưu cấu hình.");
      editing = false;
      showToast("success", "Đã lưu cấu hình thành công.");
      try {
        await refresh();
      } catch {
        if (ctx.active())
          showToast(
            "warning",
            "Cấu hình đã lưu, nhưng chưa tải lại được dữ liệu. Hãy tải lại trang để kiểm tra.",
          );
      }
    } catch (e) {
      if (!ctx.active()) return;
      let detail = e.message || "Không kết nối được API.";
      try {
        const issues = JSON.parse(detail);
        if (Array.isArray(issues))
          detail = issues
            .slice(0, 2)
            .map((i) => (i.path?.join(".") || "Giá trị") + ": " + i.message)
            .join("; ");
      } catch {
        /* Plain transport/API error. */
      }
      showToast("error", "Lưu cấu hình thất bại: " + detail.slice(0, 320));
    } finally {
      saving = false;
      if (ctx.active()) {
        $("settingsControls").disabled = false;
        $("settingsForm").removeAttribute("aria-busy");
        submit.textContent = "Lưu tham số";
      }
    }
  };

  await refresh();
}
