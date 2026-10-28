import type { ReactNode } from "react";
import type { HealthStatus } from "@sniper/core";
import { money } from "./format";
import { statusLabel } from "./vi";
export function Badge({
  children,
  tone = "muted",
}: {
  children: ReactNode;
  tone?: string;
}) {
  return <span className={`badge ${tone}`}>{children}</span>;
}
export function Health({
  label,
  health,
}: {
  label: string;
  health?: HealthStatus;
}) {
  return (
    <div className="health" title={health?.detail}>
      <span
        className={`dot ${health?.status === "healthy" ? "green" : health?.status === "unhealthy" ? "red" : "muted"}`}
      />
      <span>{label}</span>
      <small>{statusLabel(health?.status)}</small>
    </div>
  );
}
export function Pnl({ value }: { value: number }) {
  return (
    <span className={value >= 0 ? "positive" : "negative"}>
      {value > 0 ? "+" : ""}
      {money(value)}
    </span>
  );
}
