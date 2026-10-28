"use client";
import { useState, useEffect } from "react";
import type { Settings } from "@sniper/config";
const numericFields: [keyof Settings, string, string][] = [
  ["positionSizePercent", "Vốn khả dụng mỗi lệnh", "%"],
  ["maxTradeUsd", "Giá trị lệnh tối đa", "USD"],
  ["minLiquidityUsd", "Thanh khoản tối thiểu", "USD"],
  ["minScore", "Điểm chiến lược tối thiểu", "/ 100"],
  ["maxSecurityRisk", "Rủi ro bảo mật tối đa", "/ 100"],
  ["maxPriceImpactPct", "Tác động giá tối đa", "%"],
  ["maxTradesPerDay", "Số lệnh tối đa mỗi ngày", "lệnh"],
  ["maxDailyLossUsd", "Mức lỗ tối đa mỗi ngày", "USD"],
  ["maxPositions", "Số vị thế mở tối đa", "vị thế"],
  ["maxTokenExposureUsd", "Giá trị tối đa mỗi token", "USD"],
  ["maxPortfolioExposureUsd", "Giá trị danh mục tối đa", "USD"],
  ["stopLossPct", "Cắt lỗ", "%"],
  ["trailingStopPct", "Cắt lỗ bám đỉnh", "%"],
  ["maxHoldingSec", "Thời gian nắm giữ tối đa", "giây"],
  ["liquidityCollapsePct", "Ngưỡng thoát khi thanh khoản sụt giảm", "%"],
  ["maxTop1Pct", "Tỷ lệ nắm giữ tối đa của ví lớn nhất", "%"],
  ["maxTaxPct", "Thuế token tối đa", "%"],
];
export function SettingsForm({
  settings,
  onSave,
  busy,
  observationMode = false,
}: {
  settings: Settings;
  onSave: (s: Settings) => Promise<void>;
  busy: boolean;
  observationMode?: boolean;
}) {
  const [draft, setDraft] = useState(settings);
  const [message, setMessage] = useState("");
  useEffect(() => {
    setDraft(settings);
  }, [settings]);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setMessage("");
        void onSave(draft)
          .then(() => setMessage("Bot đã kiểm tra và lưu cài đặt."))
          .catch((error) => setMessage(error.message));
      }}
    >
      <div className="section-heading">
        <div>
          <h2>Cài đặt rủi ro và giao dịch</h2>
          <p>
            {observationMode
              ? "Đang quan sát với ngân sách mô phỏng 5 USD."
              : "Khối lượng tính từ số dư tài sản đầu vào khả dụng ngay trước phê duyệt, sau dự phòng phí và vốn đã giữ. Vượt giới hạn sẽ từ chối lệnh."}
          </p>
        </div>
        <button className="primary" disabled={busy} type="submit">
          Lưu cài đặt
        </button>
      </div>
      <div className="settings-grid">
        {!observationMode && (
          <label>
            Chuỗi xét lệnh mới
            <div className="input-unit">
              <select
                value={draft.activeChain}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    activeChain: e.target.value as Settings["activeChain"],
                  })
                }
              >
                <option value="solana">Solana</option>
                <option value="bnb">BNB Chain</option>
                <option value="robinhood">Robinhood Chain</option>
              </select>
            </div>
          </label>
        )}
        {numericFields.map(([key, label, unit]) => (
          <label key={key}>
            {label}
            <div className="input-unit">
              <input
                disabled={observationMode && key === "positionSizePercent"}
                required
                type="number"
                step="any"
                value={draft[key] as number}
                onChange={(e) =>
                  setDraft({ ...draft, [key]: Number(e.target.value) })
                }
              />
              <span>{unit}</span>
            </div>
          </label>
        ))}
      </div>
      <div className="section-heading">
        <div>
          <h3>Các mức chốt lời</h3>
          <p>
            Tỷ lệ bán tính theo số lượng ban đầu; tổng tỷ lệ không được vượt quá
            100%.
          </p>
        </div>
      </div>
      <div className="tp-rules">
        {draft.takeProfit.map((rule, i) => (
          <div key={i}>
            <label>
              Mức tăng %
              <input
                required
                type="number"
                step="any"
                value={rule.gainPct}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    takeProfit: draft.takeProfit.map((r, j) =>
                      i === j ? { ...r, gainPct: Number(e.target.value) } : r,
                    ),
                  })
                }
              />
            </label>
            <span>→</span>
            <label>
              Tỷ lệ bán %
              <input
                required
                type="number"
                step="any"
                value={rule.sellPct}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    takeProfit: draft.takeProfit.map((r, j) =>
                      i === j ? { ...r, sellPct: Number(e.target.value) } : r,
                    ),
                  })
                }
              />
            </label>
            <button
              type="button"
              className="subtle"
              onClick={() =>
                setDraft({
                  ...draft,
                  takeProfit: draft.takeProfit.filter((_, j) => j !== i),
                })
              }
            >
              Xóa
            </button>
          </div>
        ))}
        <button
          className="subtle"
          type="button"
          onClick={() =>
            setDraft({
              ...draft,
              takeProfit: [
                ...draft.takeProfit,
                {
                  gainPct: (draft.takeProfit.at(-1)?.gainPct ?? 0) + 30,
                  sellPct: 10,
                },
              ],
            })
          }
        >
          + Thêm mức
        </button>
      </div>
      {message && <p role="status">{message}</p>}
    </form>
  );
}
