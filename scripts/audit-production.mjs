import { readdirSync, readFileSync, writeFileSync } from "node:fs";
const rows = [];
const pattern =
  /TODO|FIXME|mock|stub|placeholder|NotImplemented|Not implemented/gi;
function visit(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (["node_modules", "generated", ".next"].includes(entry.name)) continue;
    const path = directory + "/" + entry.name;
    if (path === "docs/audit-occurrences.md") continue;
    if (entry.isDirectory()) visit(path);
    else if (/\.(ts|tsx|mjs|md)$/.test(path)) {
      const lines = readFileSync(path, "utf8").split("\n");
      lines.forEach((line, index) => {
        if (!pattern.test(line)) {
          pattern.lastIndex = 0;
          return;
        }
        pattern.lastIndex = 0;
        let category = "LEGITIMATE_FUTURE_WORK";
        if (path.startsWith("tests/")) category = "TEST_ONLY";
        else if (
          [
            "packages/engine/src/index.ts",
            "packages/engine/src/markets.ts",
            "packages/execution/src/index.ts",
          ].includes(path)
        )
          category = "MOCK_MODE_ONLY";
        else if (path.startsWith("docs/") || path.includes("browser-smoke"))
          category = "LEGITIMATE_FUTURE_WORK";
        else if (/Mock|mock-|mock:/.test(line)) category = "MOCK_MODE_ONLY";
        else if (
          /z\.literal\("MOCK"\)|source: "MOCK"|!== "MOCK"/.test(line) &&
          /config|engine|execution|bot/.test(path)
        )
          category = "PRODUCTION_BLOCKER";
        else category = "MOCK_MODE_ONLY";
        rows.push(
          "| " +
            path +
            ":" +
            (index + 1) +
            " | " +
            category +
            " | " +
            line.trim().replaceAll("|", "\\|").replaceAll("`", "\\`") +
            " |",
        );
      });
    }
  }
}
for (const directory of ["apps", "packages", "tests", "scripts", "docs"])
  visit(directory);
writeFileSync(
  "docs/audit-occurrences.md",
  "# Phân loại dấu vết mô phỏng và phần chưa hoàn thiện\n\nBản liệt kê từ mã nguồn hiện tại; tên lớp/mock trong kiểm thử không tự chứng minh đường REAL phụ thuộc mock. Đối chiếu với completion-plan.md và các cổng chặn khi chạy.\n\n| Vị trí | Phân loại | Nội dung |\n| --- | --- | --- |\n" +
    rows.join("\n") +
    "\n",
);
process.stdout.write("Đã phân loại " + rows.length + " dòng mã/tài liệu.\n");
