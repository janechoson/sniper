import type { CandidateRecord } from "@sniper/core";
import { Badge } from "./ui";
import { number } from "./format";
import {
  actionLabel,
  reasonLabel,
  riskPresentation,
  fundingEvidenceLabel,
} from "./vi";

export function DecisionPanels({ candidate }: { candidate: CandidateRecord }) {
  const ai = candidate.ai;
  const rug = candidate.rugCheck;
  const risk = riskPresentation(candidate);
  const probability = (value?: number) =>
    value === undefined ? "Chưa rõ" : `${number(value * 100, 1)}%`;
  return (
    <div className="decision-panels">
      {candidate.lifecycle && (
        <div className="decision-card source-history">
          <h3>Vòng đời token · {candidate.lifecycle.sources.join(" → ")}</h3>
          <p>
            {candidate.lifecycle.identity} · {candidate.lifecycle.pools.length}{" "}
            curve/pool được theo dõi. Xuất hiện ở nguồn mới không cấp quyền mua
            thêm.
          </p>
        </div>
      )}
      {candidate.discoveryGuard && (
        <div className="decision-card source-history">
          <h3>
            Kiểm tra ban đầu ·{" "}
            {candidate.discoveryGuard.passed
              ? "Đạt điều kiện phân tích sâu"
              : "Chưa qua guard"}
          </h3>
          <p>
            {candidate.discoveryGuard.reasons.map(reasonLabel).join(" · ") ||
              "Không thay thế kiểm tra bảo mật và khả năng bán."}{" "}
            · {number(candidate.discoveryGuard.latencyMs)} ms
          </p>
        </div>
      )}
      <section
        className="decision-card final-risk"
        aria-label="Quyết định RiskEngine"
      >
        <div className="section-heading">
          <h3>
            {candidate.observation
              ? "Điều kiện vào lệnh"
              : "Quyết định cuối · RiskEngine"}
          </h3>
          <Badge tone={risk.tone}>{risk.label}</Badge>
        </div>
        <p>{risk.title || "Chưa có lý do quyết định được ghi nhận."}</p>
        <div className="decision-outcome">
          Kết quả pipeline: <strong>{actionLabel(candidate.action)}</strong>
          {candidate.observation && <Badge tone="cyan">CHỈ QUAN SÁT</Badge>}
        </div>
        <small>
          Jev không cấp quyền giao dịch. Lệnh phải qua các giới hạn, báo giá, mô
          phỏng và phê duyệt của backend.
        </small>
      </section>
      <section
        className="decision-card rug-summary"
        aria-label="Tóm tắt bằng chứng Rug Check"
      >
        <div className="section-heading">
          <h3>Rug Check · bằng chứng</h3>
          <Badge tone="muted">
            {rug
              ? `${number(rug.dataQuality.completeness * 100)}% DỮ LIỆU`
              : "CHƯA RÕ"}
          </Badge>
        </div>
        <dl>
          {[
            ["Khả năng bán", "trading", "sellability"],
            ["Honeypot", "trading", "honeypot"],
            ["Top 10", "holders", "adjustedTop10Pct"],
            ["Quyền mint", "contract", "mintAuthority"],
            ["Quyền đóng băng", "contract", "freezeAuthority"],
            ["Round-trip (%)", "trading", "roundTripLossPct"],
          ].map(([label, section, key]) => {
            const evidence =
              rug?.[section as "trading" | "holders" | "contract"][key!];
            const stale =
              !!evidence?.validUntil &&
              Date.parse(evidence.validUntil) <= Date.now();
            const unknown =
              !evidence ||
              stale ||
              evidence.state === "UNKNOWN" ||
              evidence.value === null;
            const value = unknown
              ? "? CHƯA RÕ"
              : typeof evidence.value === "boolean"
                ? evidence.value
                  ? "Có"
                  : "Không"
                : String(evidence.value);
            return (
              <div key={key}>
                <dt>{label}</dt>
                <dd
                  className={`rug-state ${unknown ? "UNKNOWN" : evidence.state}`}
                  title={stale ? "Bằng chứng đã hết hạn" : evidence?.source}
                >
                  {value}
                </dd>
              </div>
            );
          })}
        </dl>
        <p>
          Nguồn vốn người tạo · chỉ tham khảo:{" "}
          <strong>
            {fundingEvidenceLabel(candidate.state?.creator.knownBadFunding)}
          </strong>
          . Không dùng thông tin này để duyệt, từ chối hoặc tự thoát lệnh.
        </p>
      </section>
      <section className="decision-card jev-summary" aria-label="Tín hiệu Jev">
        <div className="section-heading">
          <h3>Jev · tín hiệu AI</h3>
          <Badge tone="cyan">CHỈ TƯ VẤN</Badge>
        </div>
        {ai ? (
          <dl>
            <div>
              <dt>Đề xuất</dt>
              <dd>{ai.action ? actionLabel(ai.action) : ai.signal}</dd>
            </div>
            <div>
              <dt>Độ tin cậy</dt>
              <dd>{probability(ai.confidence)}</dd>
            </div>
            <div>
              <dt>Động lượng / 100</dt>
              <dd>
                {ai.momentumScore === undefined
                  ? "Chưa rõ"
                  : number(ai.momentumScore, 1)}
              </dd>
            </div>
            <div>
              <dt>Chất lượng / 100</dt>
              <dd>
                {ai.qualityScore === undefined
                  ? "Chưa rõ"
                  : number(ai.qualityScore, 1)}
              </dd>
            </div>
            <div>
              <dt>Đáng ngờ</dt>
              <dd>{probability(ai.suspiciousProbability)}</dd>
            </div>
            <div>
              <dt>Thiếu dữ liệu</dt>
              <dd>{probability(ai.insufficientDataProbability)}</dd>
            </div>
            <div>
              <dt>Model</dt>
              <dd>{ai.model ?? "Chưa rõ"}</dd>
            </div>
            <div>
              <dt>Độ trễ</dt>
              <dd>
                {ai.latencyMs === undefined
                  ? "Chưa rõ"
                  : `${number(ai.latencyMs)} ms`}
              </dd>
            </div>
          </dl>
        ) : (
          <p>
            Chưa có kết quả Jev hợp lệ. Token có thể bị bộ lọc từ chối trước khi
            gọi AI.
          </p>
        )}
        <small>Tín hiệu AI không phải bảo đảm an toàn token.</small>
      </section>
    </div>
  );
}
