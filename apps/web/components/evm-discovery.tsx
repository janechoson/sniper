import type { DashboardSnapshot } from "@sniper/core";
import { number, shortChain } from "./format";
import { venueLabel, reasonLabel } from "./vi";
import { Badge } from "./ui";

export function EvmDiscoveryCoverage({
  value,
}: {
  value: NonNullable<DashboardSnapshot["discovery"]>;
}) {
  const sources = Object.entries(value.evmSources ?? {});
  if (!sources.length) return null;
  return (
    <details className="panel page-details evm-discovery">
      <summary>
        Discovery BNB / Robinhood · độ phủ theo nguồn{" "}
        <span className="count">{sources.length} nguồn đang bật</span>
      </summary>
      <div
        className="table-scroll"
        tabIndex={0}
        role="region"
        aria-label="Độ phủ discovery EVM"
      >
        <table>
          <thead>
            <tr>
              {[
                "Chuỗi / nguồn",
                "Trạng thái",
                "Sự kiện",
                "Token duy nhất*",
                "Trùng",
                "Lỗi",
                "Kết nối lại",
                "RPC logic",
                "Sự kiện/s",
                "Ứng viên/s",
                "P50",
                "P95",
                "Block đã quét",
                "Token mới nhất",
              ].map((label) => (
                <th key={label}>{label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sources.map(([key, source]) => (
              <tr key={key}>
                <th>
                  {shortChain(source.chainId)} · {venueLabel(source.source)}
                </th>
                <td title={source.lastError}>
                  <Badge
                    tone={
                      source.status === "SCANNING"
                        ? "green"
                        : source.status === "DEGRADED"
                          ? "amber"
                          : "muted"
                    }
                  >
                    {(
                      {
                        SCANNING: "ĐANG QUÉT",
                        DEGRADED: "SUY GIẢM",
                        STOPPED: "ĐÃ DỪNG",
                        CONNECTING: "ĐANG KẾT NỐI",
                      } as Record<string, string>
                    )[source.status] ?? source.status}
                  </Badge>
                </td>
                {[
                  source.detected,
                  source.uniqueTokens,
                  source.duplicates,
                  source.errors,
                  source.reconnects,
                  source.rpcRequests,
                ].map((v, index) => (
                  <td key={index}>{number(v)}</td>
                ))}
                <td>{number(source.eventsPerSecond, 2)}</td>
                <td>{number(source.candidatesPerSecond, 2)}</td>
                <td>
                  {source.latencyP50Ms === null
                    ? "Chưa rõ"
                    : `${number(source.latencyP50Ms / 1000, 1)}s`}
                </td>
                <td>
                  {source.latencyP95Ms === null
                    ? "Chưa rõ"
                    : `${number(source.latencyP95Ms / 1000, 1)}s`}
                </td>
                <td>{source.lastBlock ?? "—"}</td>
                <td title={source.latest?.transactionHash}>
                  {source.latest
                    ? `${source.latest.token.slice(0, 6)}…${source.latest.token.slice(-4)}`
                    : "Chưa có sự kiện trong khoảng quét"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="funnel-notes">
        <p>
          Số liệu từ lúc watcher khởi động. Token duy nhất trong cửa sổ tối đa
          2.048 địa chỉ/nguồn; P50/P95 từ 256 mẫu gần nhất, gồm lookback ban
          đầu. RPC logic tính trước cache và gom truy vấn; không cộng để suy ra
          số HTTP thực.
        </p>
        <p>
          Token cùng chain và địa chỉ được ghép lifecycle qua nhiều nguồn. Phát
          hiện không cấp quyền mua; quote chưa được tin cậy hoặc thị trường chưa
          hỗ trợ sẽ dừng trước phân tích sâu.
        </p>
        {sources.map(([key, source]) => {
          const stats = value.sources[key];
          return (
            <p key={key}>
              {shortChain(source.chainId)} · {venueLabel(source.source)}: qua
              guard {stats?.cheapGuardPass ?? 0}, tạm dừng{" "}
              {stats?.cheapDeferred ?? 0}, phân tích sâu{" "}
              {stats?.deepAnalyzed ?? 0}, gọi Jev {stats?.jevAnalyzed ?? 0}
              {source.lastError ? ` · ${source.lastError}` : ""}
              {stats && Object.keys(stats.reasons).length
                ? ` · ${Object.entries(stats.reasons)
                    .map(([code, n]) => `${reasonLabel(code)} (${n})`)
                    .join("; ")}`
                : ""}
            </p>
          );
        })}
      </div>
    </details>
  );
}
