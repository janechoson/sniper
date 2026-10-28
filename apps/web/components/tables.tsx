import type { CandidateRecord, Position } from "@sniper/core";
import { Badge, Pnl } from "./ui";
import { money, price, shortChain, number, discoverySymbol } from "./format";
import { actionLabel, reasonLabel, venueLabel, riskPresentation } from "./vi";
import { observationStageLabel } from "./observation-panel";
export function CandidateTable({
  records,
  onSelect,
}: {
  records: CandidateRecord[];
  onSelect: (c: CandidateRecord) => void;
}) {
  const pct = (value?: number) =>
    value === undefined ? (
      <span className="unknown-value">—</span>
    ) : (
      <span className={value > 0 ? "positive" : value < 0 ? "negative" : ""}>
        {number(value, 1)}%
      </span>
    );
  return (
    <div
      className="table-scroll"
      tabIndex={0}
      role="region"
      aria-label="Danh sách token"
    >
      <table className="scanner-table">
        <thead>
          <tr>
            {[
              "Token / chuỗi",
              "Tuổi",
              "Thanh khoản",
              "5s",
              "15s",
              "Top 10",
              "Rug",
              "Jev",
              "Risk cuối",
              "Trạng thái",
            ].map((label) => (
              <th key={label}>{label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {records.map((candidate) => {
            const state = candidate.state;
            const rug = candidate.rugCheck;
            const rugDecision = rug?.decision;
            const hasUnknown =
              !rug ||
              rug.dataQuality.unknownFields.length > 0 ||
              [
                rug.contract,
                rug.trading,
                rug.holders,
                rug.liquidity,
                rug.creator,
              ].some((section) =>
                Object.values(section).some(
                  (evidence) =>
                    evidence.state === "UNKNOWN" ||
                    evidence.value === null ||
                    (!!evidence.validUntil &&
                      Date.parse(evidence.validUntil) <= Date.now()),
                ),
              );
            const rugRisk = rugDecision?.decision === "REJECT";
            const risk = riskPresentation(candidate);
            const stage = candidate.observation?.stage;
            return (
              <tr
                key={candidate.id}
                onClick={() => onSelect(candidate)}
                tabIndex={0}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onSelect(candidate);
                  }
                }}
                aria-label={`Xem phân tích ${state?.identity.symbol ?? candidate.event.tokenAddress}`}
              >
                <td>
                  <div className="token-cell">
                    <span className={`chain-icon ${candidate.event.chainId}`}>
                      {shortChain(candidate.event.chainId)}
                    </span>
                    <div>
                      <strong>
                        {discoverySymbol(candidate) ??
                          `${candidate.event.tokenAddress.slice(0, 5)}…${candidate.event.tokenAddress.slice(-4)}`}
                      </strong>
                      <small
                        className="source-badge"
                        title={candidate.event.tokenAddress}
                      >
                        {venueLabel(candidate.event.dexId)}
                      </small>
                    </div>
                  </div>
                </td>
                <td>
                  {state?.identity.ageSec === undefined
                    ? "—"
                    : `${number(state.identity.ageSec)}s`}
                </td>
                <td>
                  {state?.market.liquidityUsd === undefined ? (
                    <span className="unknown-value">Chưa rõ</span>
                  ) : (
                    money(state.market.liquidityUsd)
                  )}
                </td>
                <td>{pct(state?.market.priceChange5s)}</td>
                <td>{pct(state?.market.priceChange15s)}</td>
                <td>
                  {state?.holders.top10Pct === undefined ? (
                    <span className="unknown-value">—</span>
                  ) : (
                    `${number(state.holders.top10Pct, 1)}%`
                  )}
                </td>
                <td>
                  <Badge
                    tone={
                      rugRisk
                        ? "red"
                        : hasUnknown
                          ? "muted"
                          : rugDecision?.decision === "ALLOW"
                            ? "green"
                            : "amber"
                    }
                  >
                    {rugRisk
                      ? "TỪ CHỐI"
                      : hasUnknown
                        ? "? CHƯA RÕ"
                        : rugDecision?.decision === "ALLOW"
                          ? "ĐẠT RUG"
                          : "THEO DÕI"}
                  </Badge>
                </td>
                <td title={candidate.ai?.model}>
                  <span className="ai-advisory">
                    {candidate.ai?.action
                      ? actionLabel(candidate.ai.action)
                      : (candidate.ai?.signal ?? "—")}
                  </span>
                </td>
                <td title={risk.title}>
                  <Badge tone={risk.tone}>{risk.label}</Badge>
                </td>
                <td
                  title={
                    stage
                      ? observationStageLabel(stage)
                      : candidate.reasons.map(reasonLabel).join(" · ")
                  }
                >
                  <Badge
                    tone={
                      stage === "REJECTED" || candidate.action === "REJECT"
                        ? "red"
                        : stage === "VIRTUAL_OPEN"
                          ? "cyan"
                          : candidate.observation?.virtualAction === "WATCH"
                            ? "amber"
                            : "muted"
                    }
                  >
                    {stage === "VIRTUAL_OPEN"
                      ? "ĐÃ MUA MÔ PHỎNG"
                      : candidate.observation?.virtualAction === "BUY"
                        ? "CHỜ KIỂM TRA"
                        : candidate.observation?.virtualAction === "WATCH"
                          ? "THEO DÕI"
                          : stage === "WAITING_AI"
                            ? "CHỜ AI"
                            : stage === "DISCOVERED"
                              ? "MỚI"
                              : actionLabel(candidate.action)}
                  </Badge>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {!records.length && (
        <div className="empty">
          <strong>Chưa có token trong danh sách</strong>
          <p>
            Chờ sự kiện on-chain hoặc kiểm tra trạng thái scanner. Không hiển
            thị token mẫu.
          </p>
        </div>
      )}
    </div>
  );
}
export function PositionTable({ positions }: { positions: Position[] }) {
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            {[
              "Chuỗi / token",
              "Giá vào / hiện tại",
              "Số lượng",
              "Tổng lãi/lỗ",
              "Đã chốt",
              "Giá cao nhất",
              "Trạng thái thoát lệnh",
            ].map((h) => (
              <th key={h}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {positions.map((p) => (
            <tr key={p.id}>
              <td>
                <div className="token-cell">
                  <span className={`chain-icon ${p.chainId}`}>
                    {shortChain(p.chainId)}
                  </span>
                  <div>
                    <strong>{p.symbol}</strong>
                    <small>
                      {p.chainId} ·{" "}
                      {p.closedAt === undefined ? "đang mở" : "đã đóng"}
                    </small>
                  </div>
                </div>
              </td>
              <td>
                {price(p.entryPriceUsd)}
                <small>{price(p.currentPriceUsd)}</small>
              </td>
              <td>{number(Number(p.quantity), 2)}</td>
              <td>
                <Pnl value={p.realizedPnlUsd + p.unrealizedPnlUsd} />
              </td>
              <td>
                <Pnl value={p.realizedPnlUsd} />
              </td>
              <td>{price(p.highestPriceUsd)}</td>
              <td>
                <Badge
                  tone={
                    p.exitState === "STOP_LOSS"
                      ? "red"
                      : p.exitState.startsWith("TAKE")
                        ? "green"
                        : "muted"
                  }
                >
                  {reasonLabel(p.exitState)}
                </Badge>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!positions.length && (
        <div className="empty">
          Các vị thế trên mọi chuỗi sẽ tiếp tục được quản lý tại đây.
        </div>
      )}
    </div>
  );
}
