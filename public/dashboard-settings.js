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

export async function mount(ctx) {
  const $ = (id) => document.getElementById(id),
    post = ctx.post,
    error = ctx.error;
  let statusData = ctx.shell(),
    settingsData,
    editing = false,
    saving = false,
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
  function renderSettings(settings) {
    $("settingFields").replaceChildren(
      ...Object.entries(settings)
        .filter(
          ([key]) =>
            key !== "takeProfits" &&
            key !== "stopLossBps" &&
            !obsoleteSettingsFields.has(key),
        )
        .map(([key, value]) => {
          const d = el("div");
          const label = el(
            "label",
            {
              tokenFailureThreshold: "Số lần lỗi Position trước backoff dài",
              recentRejectTtlMs: "Backoff dài khi Position gặp lỗi (ms)",
            }[key] || key,
          );
          label.htmlFor = "setting-" + key;
          d.append(label);
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
            key === "trendingInterval" ||
            (key === "entryStrategy" && value !== "FIRST_BUY_WINS")
          ) {
            input = el("select");
            const options =
              typeof value === "boolean"
                ? ["true", "false"]
                : key === "entryStrategy"
                  ? ["STANDARD", "KRONOS"]
                  : key === "trendingInterval"
                    ? ["1m", "5m", "1h", "6h", "24h"]
                    : ["OFF", "WARNING", "EXIT"];
            options.forEach((v) => {
              const o = el("option", v);
              o.value = v;
              input.append(o);
            });
            input.value = String(value);
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
                    : "",
                ),
              );
            }
            if (key === "entryStrategy" && value === "FIRST_BUY_WINS")
              input.readOnly = true;
          }
          input.name = key;
          input.id = "setting-" + key;
          d.append(input);
          return d;
        }),
    );
    $("takeProfits").value = JSON.stringify(settings.takeProfits, null, 2);
  }

  const refresh = async () => {
    settingsData = await ctx.get("/api/settings");
    if (!editing) renderSettings(settingsData);
  };
  ctx.setRefresh(refresh);
  ctx.onShell((s) => {
    statusData = s;
    $("kill").value = String(s.newEntriesEnabled);
  });
  $("kill").value = String(statusData.newEntriesEnabled);
  $("kill").onchange = (event) =>
    post("/api/kill", { enabled: event.target.value === "true" }).catch(error);
  $("scan").onclick = () => post("/api/scan", {}).catch(error);
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
        .forEach(
          (i) =>
            (settings[i.name] = Array.isArray(settings[i.name])
              ? JSON.parse(i.value)
              : typeof settings[i.name] === "boolean"
                ? i.value === "true"
                : typeof settings[i.name] === "string"
                  ? i.value
                  : Number(i.value)),
        );
      settings.takeProfits = JSON.parse($("takeProfits").value);
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
