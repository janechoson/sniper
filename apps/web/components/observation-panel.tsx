"use client";
import { useState } from "react";
import type { DashboardSnapshot } from "@sniper/core";
import { shortChain } from "./format";
export const observationStageLabel = (stage: string) =>
  ({
    DISCOVERED: "Đã phát hiện",
    CHEAP_GUARD: "Kiểm tra nhận dạng và thị trường ban đầu",
    CHEAP_REJECTED: "Dừng ở kiểm tra ban đầu · chưa phân tích sâu",
    DISCOVERY_DEFERRED: "Đang chờ dữ liệu hoặc lượt phân tích",
    MARKET_SECURITY: "Đọc thị trường và bảo mật",
    RUG_CHECK: "Đối chiếu Rug Check",
    JEV: "Jev đang phân loại",
    WAITING_AI: "Chờ lượt phân tích AI",
    WATCHING: "Tiếp tục theo dõi",
    CHECKING_REAL_QUOTES: "Kiểm tra báo giá mua/bán thật",
    VIRTUAL_OPEN: "Đã mở vị thế mô phỏng",
    REJECTED: "Bỏ qua theo bộ lọc",
    DATA_UNAVAILABLE: "Dữ liệu chưa đủ hoặc RPC chưa phản hồi",
    AI_UNAVAILABLE: "Jev chưa phản hồi hợp lệ",
  })[stage] ?? stage;
export function ObservationPositions({
  snapshot,
  onSelect,
}: {
  snapshot: DashboardSnapshot;
  onSelect: (trade: import("@sniper/core").ObservationTrade) => void;
}) {
  const [filter, setFilter] = useState<"OPEN" | "CLOSED" | "ALL">("OPEN");
  const value = snapshot.observation;
  if (!value) return null;
  const open = value.trades.filter((t) => t.state === "OPEN").length;
  const trades = value.trades
    .filter((t) => filter === "ALL" || t.state === filter)
    .slice()
    .reverse();
  return (
    <section className="panel table-panel observation-positions">
      <div className="section-heading">
        <div>
          <h2>
            Vị thế mô phỏng{" "}
            <span className="count">
              {open} đang mở · {value.trades.length - open} đã đóng
            </span>
          </h2>
          <p>
            Theo dõi mua/bán mô phỏng theo báo giá thật. Phí và khớp lệnh thật
            chưa được xác nhận.
          </p>
        </div>
        <span className="observation-lock">5 USD / TÍN HIỆU</span>
      </div>
      <div className="filters position-filters">
        {(["OPEN", "CLOSED", "ALL"] as const).map((state) => (
          <button
            key={state}
            className={filter === state ? "active" : ""}
            onClick={() => setFilter(state)}
          >
            {state === "OPEN"
              ? "Đang theo dõi"
              : state === "CLOSED"
                ? "Đã đóng"
                : "Tất cả"}
          </button>
        ))}
      </div>
      {trades.length ? (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Token</th>
                <th>Chuỗi</th>
                <th>Ngân sách</th>
                <th>Trạng thái</th>
                <th>Thời điểm mở</th>
                <th>Thời điểm đóng</th>
              </tr>
            </thead>
            <tbody>
              {trades.map((trade) => (
                <tr key={trade.id}>
                  <td>
                    <button
                      className="text-button"
                      onClick={() => onSelect(trade)}
                    >
                      {trade.symbol || "Token chưa rõ"} ↗
                    </button>
                    <small className="observation-address">
                      {trade.tokenAddress}
                    </small>
                  </td>
                  <td>{shortChain(trade.chainId)}</td>
                  <td>{trade.budgetUsd} USD</td>
                  <td>
                    {trade.state === "CLOSED"
                      ? "Đã đóng mô phỏng"
                      : trade.exitReason
                        ? "Đã bán một phần"
                        : "Đang theo dõi"}
                  </td>
                  <td>
                    {new Date(trade.openedAt).toLocaleString("vi-VN", {
                      timeZone: "Asia/Bangkok",
                    })}
                  </td>
                  <td>
                    {trade.closedAt
                      ? new Date(trade.closedAt).toLocaleString("vi-VN", {
                          timeZone: "Asia/Bangkok",
                        })
                      : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="empty-state">
          {filter === "OPEN"
            ? "Chưa có vị thế mô phỏng đang mở."
            : filter === "CLOSED"
              ? "Chưa có vị thế mô phỏng đã đóng."
              : "Chưa có vị thế mô phỏng."}{" "}
          Khi agent có tín hiệu và báo giá đạt kiểm tra, vị thế sẽ xuất hiện tại
          đây.
        </div>
      )}
    </section>
  );
}
