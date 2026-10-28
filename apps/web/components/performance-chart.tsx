"use client";
import { useId, useState } from "react";
import { money } from "./format";

type Point = { at: number; pnlUsd: number | null };
export function PerformanceChart({
  points,
  observation = false,
}: {
  points: Point[];
  observation?: boolean;
}) {
  const [range, setRange] = useState(0);
  const [hover, setHover] = useState<Point>();
  const fillId = useId().replace(/:/g, "");
  const samples = (observation ? [] : points)
    .filter((p) => !range || p.at >= Date.now() - range)
    .sort((a, b) => a.at - b.at)
    .slice(-500);
  const known = samples.filter(
    (p) => p.pnlUsd !== null && Number.isFinite(p.pnlUsd),
  );
  const firstAt = samples[0]?.at ?? 0;
  const lastAt = samples.at(-1)?.at ?? firstAt;
  const max = Math.max(0, ...known.map((p) => p.pnlUsd!));
  const min = Math.min(0, ...known.map((p) => p.pnlUsd!));
  const span = max - min || 1;
  const x = (p: Point) =>
    48 + ((p.at - firstAt) / (lastAt - firstAt || 1)) * 810;
  const y = (p: Point) => 245 - ((p.pnlUsd! - min) / span) * 200;
  const groups: Point[][] = [];
  for (const point of samples) {
    if (point.pnlUsd === null || !Number.isFinite(point.pnlUsd)) {
      if (groups.at(-1)?.length) groups.push([]);
    } else {
      if (!groups.length) groups.push([]);
      groups.at(-1)!.push(point);
    }
  }
  const time = (at: number) =>
    new Date(at).toLocaleString("vi-VN", { timeZone: "Asia/Bangkok" });
  return (
    <div className="performance-chart">
      <div className="chart-toolbar">
        <div>
          <h2>Hiệu suất danh mục</h2>
          <p>
            P&L đã chốt ·{" "}
            {observation ? "Mô phỏng quan sát" : "Theo sổ kế toán"}
          </p>
        </div>
        <div className="range-tabs" aria-label="Khoảng thời gian biểu đồ">
          {[
            [86400000, "24h"],
            [604800000, "7 ngày"],
            [0, "Tất cả"],
          ].map(([value, label]) => (
            <button
              key={value}
              aria-pressed={range === value}
              onClick={() => {
                setRange(Number(value));
                setHover(undefined);
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {known.length ? (
        <div className="chart-plot">
          <svg
            viewBox="0 0 900 285"
            role="img"
            aria-label="Lãi lỗ USD đã chốt theo thời gian"
            onPointerLeave={() => setHover(undefined)}
            onPointerMove={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              const target = ((event.clientX - rect.left) / rect.width) * 900;
              setHover(
                known.reduce((best, point) =>
                  Math.abs(x(point) - target) < Math.abs(x(best) - target)
                    ? point
                    : best,
                ),
              );
            }}
          >
            <defs>
              <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--mint)" stopOpacity=".13" />
                <stop offset="100%" stopColor="var(--mint)" stopOpacity="0" />
              </linearGradient>
            </defs>
            {[0, 1, 2, 3, 4].map((i) => (
              <g key={i}>
                <line
                  x1="48"
                  y1={45 + i * 50}
                  x2="858"
                  y2={45 + i * 50}
                  stroke="var(--chart-grid)"
                  strokeDasharray="3 6"
                />
                <text
                  x="890"
                  y={49 + i * 50}
                  textAnchor="end"
                  fill="var(--muted)"
                  fontSize="10"
                >
                  {(max - (i * span) / 4).toFixed(2)}
                </text>
              </g>
            ))}
            {groups
              .filter((g) => g.length)
              .map((group, i) => (
                <g key={i}>
                  {group.length > 1 && (
                    <>
                      <polygon
                        points={`${x(group[0]!)},245 ${group.map((p) => `${x(p)},${y(p)}`).join(" ")} ${x(group.at(-1)!)},245`}
                        fill={`url(#${fillId})`}
                      />
                      <polyline
                        points={group.map((p) => `${x(p)},${y(p)}`).join(" ")}
                        fill="none"
                        stroke="var(--mint)"
                        strokeWidth="2"
                        strokeLinejoin="round"
                      />
                    </>
                  )}
                  {group.length === 1 && (
                    <circle
                      cx={x(group[0]!)}
                      cy={y(group[0]!)}
                      r="3"
                      fill="var(--mint)"
                    >
                      <title>
                        {time(group[0]!.at)} · {money(group[0]!.pnlUsd!)}
                      </title>
                    </circle>
                  )}
                </g>
              ))}
            {hover && (
              <g>
                <line
                  x1={x(hover)}
                  y1="35"
                  x2={x(hover)}
                  y2="245"
                  stroke="var(--muted)"
                  strokeDasharray="4 4"
                />
                <circle cx={x(hover)} cy={y(hover)} r="4" fill="var(--mint)" />
              </g>
            )}
            <text x="48" y="277" fill="var(--muted)" fontSize="10">
              {time(firstAt)}
            </text>
            <text
              x="858"
              y="277"
              textAnchor="end"
              fill="var(--muted)"
              fontSize="10"
            >
              {time(lastAt)}
            </text>
          </svg>
          <div className="chart-readout" role="status">
            {hover
              ? `${time(hover.at)} · ${money(hover.pnlUsd!)}`
              : `${known.length} mốc đã định giá · Tối đa 500 mốc gần nhất`}
          </div>
        </div>
      ) : (
        <div className="chart-empty">
          <span className="chart-empty-symbol" aria-hidden="true">
            ⌁
          </span>
          <strong>Chưa có lịch sử P&L đã xác minh</strong>
          <p>
            {observation
              ? "Lệnh quan sát theo quote chưa có đủ phí và kết quả khớp lệnh để tính P&L ròng."
              : "Biểu đồ xuất hiện khi sổ kế toán có kết quả USD đã chốt."}
          </p>
          <span>Không thay dữ liệu thiếu bằng lợi nhuận 0.</span>
        </div>
      )}
      <div className="chart-foot">
        <span>USD · {observation ? "CHỈ MÔ PHỎNG" : "DỮ LIỆU KẾ TOÁN"}</span>
        <span>
          {samples.some((p) => p.pnlUsd === null)
            ? "Giữ khoảng trống tại kết quả chưa rõ"
            : "Không nội suy dữ liệu thiếu"}
        </span>
      </div>
    </div>
  );
}
