# Structure Evidence V3 — audit trước sửa

Pipeline hiện tại: Engine.analyze → CandidateAttempts.begin → oneShotEntry → History → attemptFlow → JEV → Risk → oneShotStructure → final refresh → existing executor. JEV không có structure input. oneShotStructure đang dùng flags giá, không event-age, có thể giữ recovery qua 56 flat candles. candidate_flow_states vẫn tồn tại cho legacy/presentation nhưng entry one-shot không đọc; không tái sử dụng state đó.

Position: bounded PositionCollector → security/info/value/flow → async frozen JevExitScheduler, revision/quantity/material/freshness guards tại apply và execution. Nhánh smartMoneyExits hiện await trước saveObservation, chỉ giữ SELL; cần tách optional enrichment khỏi collection. Protective risk còn nhận smart-money EXIT signal; V3 sẽ giữ smart-money là advisory, security/liquidity/manual bảo vệ vẫn nguyên.

Thay đổi: refactor oneShotStructure tại chỗ, thêm module normalization/aggregation Smart Money dùng chung; reuse Gmgn.run/coordinator endpoint track smartmoney với một bounded feed, không Wallet Activity fanout. Candidate TTL0; Position shared bounded cache30s hoặc maxSnapshotAgeMs nếu nhỏ hơn, không dùng verdict cache. Freshness pha dùng structureMaxGapMs hiện có, candle-tail dùng maxSnapshotAgeMs+1m, không thêm phần trăm giá. Structure trước JEV, giữ components/provenance/missing data và log structured. JEV/Risk/executor vẫn giữ authority, Smart Money không tự BUY/SELL.

Không đổi .env, không provider probe mới, không restart LIVE. Tests dùng fixtures/mocks; build staging để không xóa dist đang chạy.
