import {
  aiClassificationSchema,
  DomainError,
  type AIProvider,
  type AIClassification,
  type NormalizedTokenState,
} from "@sniper/core";
import { withTimeout } from "@sniper/shared";
export { JevAIProvider, sanitizeJevState } from "./jev";
// Không suy đoán lược đồ hay địa chỉ API của Jev. Bên tích hợp cần cung cấp
// kết nối theo tài liệu để ánh xạ phản hồi thực tế sang lược đồ chuẩn hóa này.
export type JevTransport = (
  state: Readonly<NormalizedTokenState>,
  signal: AbortSignal,
) => Promise<unknown>;
export class JevProvider implements AIProvider {
  readonly id = "jev";
  constructor(
    private readonly transport?: JevTransport,
    private readonly timeoutMs = 3000,
  ) {}
  async classify(state: NormalizedTokenState): Promise<AIClassification> {
    if (!this.transport)
      throw new DomainError(
        "AI_ERROR",
        "Chưa cấu hình kết nối Jev theo tài liệu API",
      );
    const controller = new AbortController();
    try {
      return aiClassificationSchema.parse(
        await withTimeout(
          this.transport(structuredClone(state), controller.signal),
          this.timeoutMs,
        ),
      );
    } catch {
      throw new DomainError(
        "AI_ERROR",
        "Không kết nối được Jev hoặc kết quả phân loại không hợp lệ",
      );
    } finally {
      controller.abort();
    }
  }
}
export class MockAIProvider implements AIProvider {
  readonly id = "mock-ai";
  async classify(state: NormalizedTokenState): Promise<AIClassification> {
    if (state.identity.source !== "MOCK")
      throw new DomainError(
        "AI_ERROR",
        "Bộ phân loại giả lập chỉ nhận trạng thái từ dữ liệu giả lập",
      );
    return aiClassificationSchema.parse({
      signal: (state.market.priceChange15s ?? 0) > 10 ? "buy" : "neutral",
      confidence: 0.82,
      momentumScore: 80,
      qualityScore: 80,
      riskScore: 15,
    });
  }
}
export async function safeClassify(
  provider: AIProvider,
  state: NormalizedTokenState,
  timeoutMs = 3500,
): Promise<AIClassification | undefined> {
  try {
    return aiClassificationSchema.parse(
      await withTimeout(provider.classify(structuredClone(state)), timeoutMs),
    );
  } catch {
    return undefined;
  }
}
export * from "./rug-risk";
