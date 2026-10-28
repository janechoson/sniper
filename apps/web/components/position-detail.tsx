import type { DashboardSnapshot } from "@sniper/core";
import type { PositionSelection } from "./terminal-overview";
import { shortAddress } from "./terminal-overview";
import { money, price, shortChain, number } from "./format";
import { reasonLabel } from "./vi";
import { Badge, Pnl } from "./ui";
import { DecisionPanels } from "./decision-panels";

export function PositionDetail({
  position,
  snapshot,
  onDismiss,
  onClose,
}: {
  position: PositionSelection;
  snapshot: DashboardSnapshot;
  onDismiss: () => void;
  onClose: (id: string) => void;
}) {
  const value = position.value;
  const managed = position.kind === "managed" ? position.value : undefined;
  const virtual = position.kind === "observation" ? position.value : undefined;
  const candidate = snapshot.candidates.find((c) =>
    virtual
      ? c.id === virtual.candidateId
      : c.event.chainId === value.chainId &&
        c.event.tokenAddress === value.tokenAddress,
  );
  const canClose =
    managed &&
    !["CLOSED", "FAILED"].includes(managed.state) &&
    (managed.mode === "PAPER" || managed.mode === "LIVE");
  return (
    <div className="modal-backdrop" onClick={onDismiss}>
      <section
        className="detail-modal panel"
        role="dialog"
        aria-modal="true"
        aria-label="Chi tiết vị thế"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="section-heading">
          <div>
            <div className="eyebrow">CHI TIẾT VỊ THẾ</div>
            <h2>
              {virtual?.symbol ||
                candidate?.state?.identity.symbol ||
                shortAddress(value.tokenAddress)}{" "}
              · {shortChain(value.chainId)}
            </h2>
          </div>
          <button className="subtle" onClick={onDismiss}>
            Đóng ✕
          </button>
        </div>
        <div className="detail-summary">
          <Badge tone={managed?.mode === "LIVE" ? "red" : "cyan"}>
            {virtual ? "MÔ PHỎNG QUAN SÁT" : managed?.mode}
          </Badge>
          <code>{value.tokenAddress}</code>
        </div>
        <dl className="position-detail-grid">
          <div>
            <dt>Thời điểm mở</dt>
            <dd>
              {new Date(value.openedAt).toLocaleString("vi-VN", {
                timeZone: "Asia/Bangkok",
              })}
            </dd>
          </div>
          <div>
            <dt>Trạng thái</dt>
            <dd>{reasonLabel(value.state)}</dd>
          </div>
          <div>
            <dt>Ngân sách vào lệnh</dt>
            <dd>
              {virtual
                ? `${virtual.budgetUsd} USD · mô phỏng`
                : managed
                  ? `${managed.investedQuoteAmount} đơn vị nhỏ nhất của quote`
                  : "Chưa rõ"}
            </dd>
          </div>
          <div>
            <dt>Số lượng còn lại (đơn vị nhỏ nhất)</dt>
            <dd>
              {managed?.remainingQuantity ?? virtual?.quantity ?? "Chưa rõ"}
            </dd>
          </div>
          <div>
            <dt>Giá vào</dt>
            <dd>
              {managed?.entryPriceUsd === undefined
                ? "Chưa rõ"
                : price(managed.entryPriceUsd)}
            </dd>
          </div>
          <div>
            <dt>Quote thoát gần nhất (đơn vị nhỏ nhất)</dt>
            <dd>
              {managed?.latestExitQuoteAmount ??
                virtual?.exitQuoteAmount ??
                "Chưa rõ"}
            </dd>
          </div>
          <div>
            <dt>P&L theo quote thoát</dt>
            <dd>
              {managed?.executablePnlUsd === undefined ? (
                "Chưa rõ"
              ) : (
                <Pnl value={managed.executablePnlUsd} />
              )}
            </dd>
          </div>
          <div>
            <dt>Thanh khoản lúc mở</dt>
            <dd>
              {managed?.initialLiquidityUsd === undefined
                ? "Chưa rõ"
                : money(managed.initialLiquidityUsd)}
            </dd>
          </div>
          <div>
            <dt>Khả năng bán</dt>
            <dd className="rug-state UNKNOWN">
              {virtual
                ? "? CHƯA RÕ · QUOTE CHƯA CHỨNG MINH BÁN ĐƯỢC"
                : "Xem bằng chứng Rug Check kèm thời điểm"}
            </dd>
          </div>
          <div>
            <dt>DEX / provider</dt>
            <dd>
              {managed?.providerId ?? candidate?.event.dexId ?? "Chưa rõ"}
            </dd>
          </div>
          {managed && (
            <>
              <div>
                <dt>Cắt lỗ / bám đỉnh</dt>
                <dd>
                  {number(managed.exitPolicy.stopLossPct)}% /{" "}
                  {number(managed.exitPolicy.trailingStopPct)}%
                </dd>
              </div>
              <div>
                <dt>Chốt lời</dt>
                <dd>
                  {managed.exitPolicy.takeProfit
                    .map(
                      (level) => `+${level.gainPct}% → bán ${level.sellPct}%`,
                    )
                    .join(" · ")}
                </dd>
              </div>
            </>
          )}
        </dl>
        {virtual && (
          <p>
            Mua/bán mô phỏng theo quote thật. Phí và khớp lệnh chưa xác minh;
            không hiển thị lợi nhuận ước đoán.
          </p>
        )}
        {canClose && (
          <button className="danger" onClick={() => onClose(managed.id)}>
            Yêu cầu đóng vị thế…
          </button>
        )}
        {candidate ? (
          <DecisionPanels candidate={candidate} />
        ) : (
          <p>
            Không có bản phân tích tương ứng trong cache hiện tại. Không thay
            bằng kết luận an toàn.
          </p>
        )}
      </section>
    </div>
  );
}
