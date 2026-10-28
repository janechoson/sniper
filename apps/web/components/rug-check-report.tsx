import type {
  RugCheckSnapshot,
  SecurityEvidence,
  RugAnalytics,
  SecurityReadinessRow,
} from "@sniper/core";
import { reasonLabel } from "./vi";
import { number, shortChain } from "./format";
const labels: Record<string, string> = {
  validToken: "Token hợp lệ",
  bytecodeHash: "Hash bytecode",
  tokenProgram: "Chương trình token",
  supply: "Tổng cung nguyên",
  decimals: "Số chữ số thập phân",
  owner: "Owner được đọc",
  ownershipRenounced: "Owner bằng zero",
  implementation: "Hợp đồng triển khai",
  implementationCodeHash: "Hash bytecode triển khai",
  proxy: "Bằng chứng proxy",
  privilegedRoles: "Đặc quyền",
  mintAuthority: "Quyền mint",
  freezeAuthority: "Quyền đóng băng",
  mintCapability: "Phát hành thêm",
  pauseCapability: "Tạm dừng",
  blacklistCapability: "Chặn ví",
  whitelistRestriction: "Danh sách ví",
  transferRestriction: "Hạn chế chuyển",
  maxTransaction: "Giới hạn giao dịch",
  maxWallet: "Giới hạn mỗi ví",
  mutableTaxes: "Đổi phí/thuế",
  tradingControl: "Điều khiển giao dịch",
  transferHook: "Transfer hook",
  permanentDelegate: "Đại diện vĩnh viễn",
  defaultAccountState: "Trạng thái mặc định",
  nonTransferable: "Không chuyển được",
  metadataAuthority: "Quyền metadata pointer",
  arbitraryExternalCalls: "Gọi hợp đồng ngoài",
  supplyManipulation: "Đổi số dư/tổng cung",
  verifiedSource: "Nguồn mã do provider xác minh",
  extensions: "Phần mở rộng",
  externalWarnings: "Cảnh báo provider",
  buyQuote: "Báo giá mua",
  sellQuote: "Báo giá bán",
  sellability: "Khả năng bán có mô phỏng",
  honeypot: "Kiểm tra honeypot",
  buyTaxPct: "Thuế mua (%)",
  sellTaxPct: "Thuế bán (%)",
  transferTaxPct: "Phí chuyển (%)",
  sellRestriction: "Hạn chế bán",
  buyAmount: "Lượng mua đầu vào",
  expectedReceived: "Token nhận tối thiểu",
  sellAmount: "Token bán lại",
  expectedReturned: "Lượng nhận lại tối thiểu",
  roundTripLossPct: "Tổn hao round-trip (%)",
  networkFeesKnown: "Đã biết phí mạng",
  dexFees: "Phí DEX riêng",
  routeFees: "Phí tuyến riêng",
  priceImpactPct: "Tác động giá (%)",
  slippageBps: "Trượt giá bps",
  usd: "Thanh khoản USD ước tính",
  baseAmount: "Dự trữ token",
  quoteAmount: "Dự trữ tài sản định giá",
  poolAgeSec: "Tuổi pool (giây)",
  lpOwnership: "Phân bố LP",
  lpConcentrationPct: "Tập trung LP (%)",
  lpBurned: "LP tại địa chỉ zero (%)",
  lpLocked: "LP khóa",
  lpLockedPct: "LP khóa do provider báo (%)",
  unlockAt: "Thời điểm mở khóa",
  creatorLpPct: "LP người tạo pool nắm (%)",
  recentRemovalPct: "Sụt thanh khoản quan sát (%)",
  recentAdditionPct: "Thanh khoản bổ sung (%)",
  count: "Số holder",
  top1Pct: "Top 1 thô (%)",
  top5Pct: "Top 5 thô (%)",
  top10Pct: "Top 10 thô (%)",
  top20Pct: "Top 20 thô (%)",
  adjustedTop1Pct: "Top 1 sau loại trừ (%)",
  adjustedTop5Pct: "Top 5 sau loại trừ (%)",
  adjustedTop10Pct: "Top 10 sau loại trừ (%)",
  adjustedTop20Pct: "Top 20 sau loại trừ (%)",
  creatorHoldingPct: "Người tạo nắm (%)",
  deployerHoldingPct: "Deployer nắm (%)",
  excludedSupplyPct: "Tổng cung loại trừ (%)",
  exclusions: "Loại trừ đã xác minh",
  coverage: "Phạm vi holder",
  suspiciousClusterPct: "Cluster đáng ngờ (%)",
  freshWalletPct: "Ví mới (%)",
  address: "Địa chỉ có bằng chứng",
  role: "Vai trò xác minh",
  history: "Phạm vi lịch sử",
  previousTokens: "Token từng quan sát",
  activeTokens: "Token còn tồn tại",
  shortLivedTokens: "Token tồn tại ngắn",
  criticalIncidents: "Sự cố có chứng cứ",
  liquidityRemovals: "Rút LP có actor chứng minh",
  extremeDumps: "Giảm giá cực mạnh",
  sellabilityFailures: "Lỗi bán được chứng minh",
  previousLifespanSec: "Thời gian tồn tại quan sát",
  previousConcentrationPct: "Holder trước đây (%)",
  previousLiquidityBehavior: "Lịch sử thanh khoản",
};
const values: Record<string, string> = {
  ACTIVE: "Đang có hiệu lực",
  REVOKED: "Đã thu hồi",
  NONE: "Không có theo dữ liệu đọc",
  FROZEN: "Đóng băng",
  INITIALIZED: "Đã khởi tạo",
  COMPLETE: "Đủ theo tổng cung",
  OBSERVED_DATASET_ONLY: "Chỉ dataset nội bộ",
  POOL_CREATOR: "Người tạo pool",
  TOKEN_DEPLOYER: "Deployer",
  TOKEN_CREATOR: "Người tạo token được chương trình xác minh",
  SELLABLE: "Bán được trong mô phỏng",
  NOT_SELLABLE: "Mô phỏng bán thất bại",
  PASS: "Đạt trong phạm vi kiểm tra",
  FAIL: "Không đạt",
  UNKNOWN: "Chưa rõ",
};
const states = {
  SAFE: "Đã có bằng chứng",
  RISK: "Có rủi ro",
  UNKNOWN: "Chưa rõ",
  NOT_APPLICABLE: "Không áp dụng",
};
function EvidenceTable({
  entries,
}: {
  entries: Record<string, SecurityEvidence>;
}) {
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Hạng mục</th>
            <th>Giá trị</th>
            <th>Bằng chứng</th>
            <th>Nguồn / thời điểm</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(entries).map(([key, e]) => {
            const stale =
              e.validUntil && Date.parse(e.validUntil) <= Date.now();
            return (
              <tr key={key}>
                <th scope="row">{labels[key] ?? key}</th>
                <td>
                  {e.value === null
                    ? "Chưa rõ"
                    : typeof e.value === "boolean"
                      ? e.value
                        ? "Có"
                        : "Không"
                      : typeof e.value === "number"
                        ? number(e.value, 2)
                        : (values[e.value] ?? e.value)}
                </td>
                <td>
                  <span
                    className={"rug-state " + (stale ? "UNKNOWN" : e.state)}
                  >
                    {stale ? "Đã hết hạn" : states[e.state]}
                  </span>
                </td>
                <td>
                  <small>
                    {e.origin} · {e.source}
                  </small>
                  <br />
                  <time>{new Date(e.observedAt).toLocaleString("vi-VN")}</time>
                  {e.reference && (
                    <p className="rug-reference">{e.reference}</p>
                  )}
                  {e.reasonCodes.map((code) => (
                    <p key={code}>{reasonLabel(code)}</p>
                  ))}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
export function RugCheckReport({ snapshot }: { snapshot: RugCheckSnapshot }) {
  const critical =
    snapshot.decision?.decision === "REJECT" &&
    snapshot.decision.reasonCodes.some((r) =>
      [
        "HONEYPOT_DETECTED",
        "SELL_SIMULATION_FAILED",
        "BLACKLIST_CAPABILITY",
        "TRANSFER_RESTRICTED",
        "TOP1_CONCENTRATION_HIGH",
        "TOP10_CONCENTRATION_HIGH",
        "CREATOR_CRITICAL_HISTORY",
        "ROUND_TRIP_LOSS_HIGH",
        "LIQUIDITY_REMOVAL_DETECTED",
      ].includes(r),
    );
  const overall = critical
    ? "RỦI RO CAO"
    : snapshot.dataQuality.unknownFields.length
      ? "CHƯA RÕ"
      : snapshot.decision?.decision === "ALLOW"
        ? "ĐỦ BẰNG CHỨNG THEO CHÍNH SÁCH"
        : "CẢNH BÁO";
  const jev = snapshot.jev;
  return (
    <section className="rug-report" aria-label="Bảo mật token và Rug Check">
      <div className="section-heading">
        <div>
          <h3>Bảo mật token / Rug Check</h3>
          <p>Nhiều nguồn độc lập · không có điểm tổng hợp tùy ý</p>
        </div>
        <strong className={"rug-state " + (critical ? "RISK" : "UNKNOWN")}>
          {overall}
        </strong>
      </div>
      <p>
        Đã có dữ liệu cho {number(snapshot.dataQuality.completeness * 100, 1)}%
        hạng mục. Đây là độ đầy đủ dữ liệu, không phải xác suất an toàn.
      </p>
      <p className="rug-reference">
        Hash bằng chứng: <code>{snapshot.snapshotHash}</code>
      </p>
      {(
        [
          ["contract", "Hợp đồng và quyền"],
          ["trading", "Giao dịch, khả năng bán và round-trip"],
          ["liquidity", "Thanh khoản / LP"],
          ["holders", "Holder: thô và sau loại trừ"],
          ["creator", "Người tạo / deployer"],
        ] as const
      ).map(([key, label]) => (
        <details key={key} open={key === "trading"}>
          <summary>{label}</summary>
          <EvidenceTable entries={snapshot[key]} />
        </details>
      ))}
      <details>
        <summary>Cluster holder</summary>
        {snapshot.holderClusters.length ? (
          snapshot.holderClusters.map((c, i) => (
            <div key={i}>
              <p>
                {c.confidence} · {c.wallets.length} ví
              </p>
              <p>Không kết luận các ví thuộc cùng người.</p>
              <p>{c.reasonCodes.map(reasonLabel).join(" · ")}</p>
            </div>
          ))
        ) : (
          <p>
            Chưa có dữ liệu funding đủ để phân nhóm; không kết luận không có
            cluster.
          </p>
        )}
      </details>
      <details open>
        <summary>Nguồn bằng chứng độc lập</summary>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Provider</th>
                <th>Trạng thái</th>
                <th>Độ trễ</th>
                <th>Hạng mục</th>
              </tr>
            </thead>
            <tbody>
              {snapshot.externalProviders.map((p) => (
                <tr key={p.provider}>
                  <td>{p.provider}</td>
                  <td>
                    {
                      {
                        OK: "Đã nhận bằng chứng",
                        DISABLED: "Chưa bật",
                        UNSUPPORTED: "Không hỗ trợ chuỗi",
                        UNAVAILABLE: "Không khả dụng",
                      }[p.status]
                    }
                    {p.error && <small> · {reasonLabel(p.error)}</small>}
                  </td>
                  <td>{number(p.latencyMs)} ms</td>
                  <td>{p.findings.length}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {snapshot.disagreements.map((d, i) => (
          <p key={i}>
            Bất đồng: {labels[d.field.split(".")[1]!] ?? d.field} ·{" "}
            {d.providers.join(" / ")}
          </p>
        ))}
      </details>
      <details open>
        <summary>Phân tích Jev — chỉ tư vấn</summary>
        {jev?.status === "AVAILABLE" ? (
          <>
            <p>
              Mức chỉ báo rug: {jev.rugRiskScore}/4 · Đáng ngờ:{" "}
              {jev.suspiciousProbability === undefined
                ? "Chưa rõ"
                : `${number(jev.suspiciousProbability * 100, 1)}%`}{" "}
              · Thiếu dữ liệu:{" "}
              {jev.insufficientDataProbability === undefined
                ? "Chưa rõ"
                : `${number(jev.insufficientDataProbability * 100, 1)}%`}
            </p>
            <p>
              Nhóm: {jev.riskCategory} · Tư vấn:{" "}
              {jev.advisoryAction === "PASS"
                ? "Tiếp tục đánh giá"
                : jev.advisoryAction === "WATCH"
                  ? "Theo dõi"
                  : "Bỏ qua"}
            </p>
            <p>
              Model: {jev.resolvedModel} · {number(jev.latencyMs)} ms · token
              vào/ra: {jev.inputTokens ?? "Chưa rõ"}/
              {jev.outputTokens ?? "Chưa rõ"}
            </p>
          </>
        ) : (
          <p>
            Chưa có kết quả Jev hợp lệ. Bộ lọc bắt buộc có thể từ chối trước AI.
          </p>
        )}
      </details>
      <details open>
        <summary>Quyết định Risk Engine và lý do</summary>
        <strong>
          {snapshot.decision?.decision === "ALLOW"
            ? "CHO PHÉP TIẾP TỤC"
            : snapshot.decision?.decision === "REJECT"
              ? "TỪ CHỐI"
              : "THEO DÕI"}
        </strong>
        <p>
          {snapshot.decision?.reasonCodes.map(reasonLabel).join(" · ") ||
            "Chưa ghi nhận kết luận cuối"}
        </p>
        <p>
          Quyết định mua còn phải qua giới hạn danh mục, báo giá mới và
          ApprovedTradeIntent.
        </p>
      </details>
      <details>
        <summary>Chất lượng dữ liệu và độ trễ</summary>
        <p>{snapshot.dataQuality.sources.join(" · ")}</p>
        <p>Các hạng mục chưa rõ:</p>
        <p>
          {snapshot.dataQuality.unknownFields
            .map((f) => labels[f.split(".")[1]!] ?? f)
            .join(" · ")}
        </p>
        {Object.entries(snapshot.latencies).map(([key, value]) => (
          <p key={key}>
            {key}: {number(value)} ms
          </p>
        ))}
      </details>
    </section>
  );
}
export function RugSecurityOverview({
  analytics,
  readiness,
}: {
  analytics: RugAnalytics;
  readiness: SecurityReadinessRow[];
}) {
  const names: Record<string, string> = {
    tokenSecurity: "Bảo mật token",
    holders: "Holder",
    creator: "Creator",
    liquidity: "Thanh khoản",
    buyQuote: "Quote mua",
    sellQuote: "Quote bán",
    sellSimulation: "Mô phỏng bán",
    jev: "Jev",
    riskEngine: "Risk Engine",
  };
  return (
    <section className="panel rug-overview">
      <h2>Bảo mật và mức sẵn sàng theo chuỗi</h2>
      <p>
        Phạm vi: token được quan sát gần nhất trên mỗi chuỗi; không chứng minh
        mọi token trên chuỗi an toàn.
      </p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Thành phần</th>
              {readiness.map((r) => (
                <th key={r.chainId}>{shortChain(r.chainId)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Object.entries(names).map(([key, name]) => (
              <tr key={key}>
                <th scope="row">{name}</th>
                {readiness.map((r) => (
                  <td key={r.chainId}>
                    {
                      {
                        READY: "Sẵn sàng",
                        PARTIAL: "Một phần",
                        NOT_READY: "Chưa sẵn sàng",
                        UNKNOWN: "Chưa rõ",
                      }[r.components[key] ?? "UNKNOWN"]
                    }
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p>
        {analytics.tokensScanned} token trong cache · {analytics.tokensRejected}{" "}
        bị từ chối · {analytics.providerDisagreements} token có bất đồng nguồn.
      </p>
      <details>
        <summary>Thống kê lý do và độ trễ bảo mật</summary>
        {Object.entries(analytics.reasons).map(([code, n]) => (
          <p key={code}>
            {reasonLabel(code)}: {n}
          </p>
        ))}
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Giai đoạn</th>
                <th>Số mẫu</th>
                <th>p50</th>
                <th>p95</th>
                <th>p99</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(analytics.latency).map(([key, v]) => (
                <tr key={key}>
                  <td>{key}</td>
                  <td>{v.samples}</td>
                  {[v.p50, v.p95, v.p99].map((n, i) => (
                    <td key={i}>
                      {n === null ? "Chưa đủ mẫu" : number(n) + " ms"}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p>
          Ứng viên sai âm: {analytics.outcomeEvents.falseNegativeCandidates} ·
          ứng viên sai dương: {analytics.outcomeEvents.falsePositiveCandidates}.
          Chỉ là nhóm cần đánh giá lại.
        </p>
        <p>{analytics.definitions.liquidityCollapse}</p>
      </details>
    </section>
  );
}
