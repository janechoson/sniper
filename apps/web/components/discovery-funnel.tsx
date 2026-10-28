import type { DashboardSnapshot } from "@sniper/core";
import { number } from "./format";
import { venueLabel, reasonLabel } from "./vi";
export function DiscoveryFunnel({
  value,
}: {
  value: NonNullable<DashboardSnapshot["discovery"]>;
}) {
  return (
    <details className="panel page-details source-funnel">
      <summary>
        Discovery Solana · funnel theo nguồn{" "}
        <span className="count">
          {number(value.eventsPerSecond, 2)} sự kiện/s · {value.queueDepth} chờ
          · {value.activeAnalysis} đang xử lý toàn hệ thống
        </span>
      </summary>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              {[
                "Nguồn",
                "Phát hiện",
                "Qua guard",
                "Dừng ở guard",
                "Phân tích sâu",
                "Rug từ chối",
                "Sellability đạt",
                "Gọi Jev",
                "Risk đạt",
                "Mua mô phỏng",
              ].map((label) => (
                <th key={label}>{label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Object.entries(value.sources)
              .filter(([source]) => !source.includes(":"))
              .map(([source, stats]) => (
                <tr key={source}>
                  <th>{venueLabel(source)}</th>
                  {[
                    stats.detected,
                    stats.cheapGuardPass,
                    stats.cheapRejected,
                    stats.deepAnalyzed,
                    stats.rugRejected,
                    stats.sellabilityPass,
                    stats.jevAnalyzed,
                    stats.riskApproved,
                    stats.paperBought,
                  ].map((count, index) => (
                    <td key={index}>{number(count)}</td>
                  ))}
                </tr>
              ))}
          </tbody>
        </table>
      </div>
      <div className="funnel-notes">
        {Object.entries(value.watchers ?? {}).map(([source, stats]) => (
          <p key={source}>
            {venueLabel(source)} watcher · {stats.pendingSignatures} signature
            chờ · {stats.droppedHints} tín hiệu vượt giới hạn ·{" "}
            {stats.duplicates} thông báo trùng · {stats.validationFailures} dữ
            liệu lỗi · {stats.expired} hết TTL. Không coi dữ liệu lấy mẫu là
            toàn bộ hoạt động on-chain.
          </p>
        ))}
        <p>
          Phát hiện tính theo pool/curve đã lưu; các bước phân tích tính theo
          lượt đánh giá, có thể gồm đánh giá lại. Guard chỉ kiểm tra ban đầu;
          không phải bằng chứng an toàn. Quote-only chưa được tính SELLABLE.
        </p>
        <p>
          Trùng lặp bỏ qua: {number(value.duplicates)} · Áp lực hàng đợi:{" "}
          {number(value.backpressure)} · Ứng viên/s:{" "}
          {number(value.candidatesPerSecond, 2)} · Độ trễ phát hiện TB:{" "}
          {value.averageDiscoveryLatencyMs === null
            ? "Chưa rõ"
            : `${number(value.averageDiscoveryLatencyMs)} ms`}{" "}
          · Phân tích TB:{" "}
          {value.averageAnalysisLatencyMs === null
            ? "Chưa rõ"
            : `${number(value.averageAnalysisLatencyMs)} ms`}
        </p>
        {Object.entries(value.rpc).map(([chain, stats]) => (
          <p key={chain}>
            {chain.toUpperCase()} RPC · {number(stats.requests)} yêu cầu logic ·{" "}
            {number(stats.requestsPerSecond, 2)}/s · TB{" "}
            {number(stats.averageLatencyMs)} ms (gồm chờ/retry) ·{" "}
            {stats.queueDepth} chờ/đang chạy · {stats.failures} lỗi
          </p>
        ))}
        <details>
          <summary>Lý do dừng theo nguồn</summary>
          {Object.entries(value.sources)
            .filter(([source]) => !source.includes(":"))
            .map(([source, stats]) => (
              <div key={source}>
                <strong>{venueLabel(source)}</strong>
                {Object.entries(stats.reasons).length ? (
                  Object.entries(stats.reasons).map(([reason, count]) => (
                    <p key={reason}>
                      {reasonLabel(reason)} · {number(count)}
                    </p>
                  ))
                ) : (
                  <p>Chưa có lý do được ghi nhận.</p>
                )}
              </div>
            ))}
        </details>
      </div>
    </details>
  );
}
