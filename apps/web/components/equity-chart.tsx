import type { Position } from "@sniper/core";
export function EquityChart({ positions }: { positions: Position[] }) {
  const closed = positions
    .filter((p) => p.closedAt !== undefined)
    .sort((a, b) => a.closedAt! - b.closedAt!);
  let total = 0;
  const values = [
    0,
    ...closed.map((p) => {
      total += p.realizedPnlUsd;
      return total;
    }),
  ];
  const max = Math.max(1, ...values),
    min = Math.min(-1, ...values);
  const points = values
    .map(
      (v, i) =>
        `${20 + (i / Math.max(1, values.length - 1)) * 860},${160 - ((v - min) / (max - min)) * 130}`,
    )
    .join(" ");
  return (
    <div className="chart">
      <div className="chart-label">
        <span>Lãi/lỗ mô phỏng đã chốt gần đây</span>
        <small>{closed.length} vị thế đã đóng · đã tính chi phí mô phỏng</small>
      </div>
      <svg
        viewBox="0 0 900 190"
        role="img"
        aria-label="Lãi/lỗ mô phỏng đã chốt lũy kế"
      >
        {[35, 80, 125, 170].map((y) => (
          <line
            key={y}
            x1="20"
            y1={y}
            x2="880"
            y2={y}
            stroke="var(--chart-grid)"
            strokeLinecap="round"
            strokeDasharray="3 6"
          />
        ))}
        <polyline
          points={values.length === 1 ? "20,95 880,95" : points}
          fill="none"
          stroke="var(--mint)"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="2.5"
        />
        {!closed.length && (
          <text
            x="450"
            y="60"
            fill="var(--muted)"
            textAnchor="middle"
            fontSize="13"
          >
            Biểu đồ sẽ xuất hiện khi có vị thế đã đóng
          </text>
        )}
      </svg>
      <div className="chart-foot">
        <span>Lần đóng đầu tiên</span>
        <span>Lần đóng gần nhất</span>
      </div>
    </div>
  );
}
