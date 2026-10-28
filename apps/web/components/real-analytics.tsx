import type { StrategyAnalytics } from "@sniper/core";
import { money, number } from "./format";
import { PerformanceChart } from "./performance-chart";
export function RealAnalytics({ value }: { value: StrategyAnalytics }) {
  const metric = (v: number | null, percent = false) =>
    v === null ? "Chưa rõ" : `${number(v, 2)}${percent ? "%" : ""}`;
  return (
    <div className="real-analytics">
      <p>
        {value.scope.closedTrades} vị thế đã đóng ·{" "}
        {value.scope.unknownNetResults} kết quả chưa đủ dữ liệu chi phí. Thống
        kê nhóm dựa trên {value.scope.cachedCandidates} quyết định đang lưu
        trong bộ nhớ.
      </p>
      <PerformanceChart points={value.realizedEquity} />
      <div className="analytics-metrics">
        <span>
          Lợi nhuận trung bình <b>{metric(value.averageReturnPct, true)}</b>
        </span>
        <span>
          Trung vị <b>{metric(value.medianReturnPct, true)}</b>
        </span>
        <span>
          Hệ số lợi nhuận <b>{metric(value.profitFactor)}</b>
        </span>
        <span>
          Sụt giảm lớn nhất{" "}
          <b>
            {value.maxDrawdownUsd === null
              ? "Chưa rõ"
              : money(value.maxDrawdownUsd)}
          </b>
        </span>
      </div>
      <details>
        <summary>Thống kê theo nhóm và độ trễ</summary>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Nhóm</th>
                <th>Ứng viên</th>
                <th>Vị thế đóng</th>
                <th>Lãi/lỗ USD</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries({
                Chuỗi: value.byChain,
                DEX: value.byDex,
                "Chiến lược": value.byStrategy,
              }).flatMap(([label, groups]) =>
                Object.entries(groups).map(([id, g]) => (
                  <tr key={`${label}:${id}`}>
                    <td>
                      {label}: {id}
                    </td>
                    <td>{g.candidates}</td>
                    <td>{g.trades}</td>
                    <td>
                      {g.netPnlUsd === null ? "Chưa rõ" : money(g.netPnlUsd)}
                    </td>
                  </tr>
                )),
              )}
            </tbody>
          </table>
        </div>
        <p>Độ trễ trung bình / trung vị, chỉ tính các mốc đã ghi nhận:</p>
        {Object.entries(value.latency).map(([stage, v]) => (
          <p key={stage}>
            {(
              {
                discovery: "Phát hiện",
                normalization: "Chuẩn hóa",
                features: "Thu thập dữ liệu",
                security: "Bảo mật",
                hardFilter: "Lọc bắt buộc",
                ai: "AI",
                risk: "Rủi ro",
                quotes: "Báo giá",
                simulation: "Mô phỏng",
                submission: "Gửi giao dịch",
                confirmation: "Xác nhận",
                total: "Tổng",
              } as Record<string, string>
            )[stage] ?? stage}
            : {metric(v.averageMs)} / {metric(v.medianMs)} ms · {v.samples} mẫu
          </p>
        ))}
      </details>
    </div>
  );
}
