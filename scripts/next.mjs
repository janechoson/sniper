import { loadEnvFile } from "node:process";
// Next suy ra NODE_OPTIONS từ execArgv khi phát triển. Nạp cấu hình tại đây
// để cờ --env-file không bị truyền vào NODE_OPTIONS của tiến trình con.
try {
  loadEnvFile(".env");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
await import("next/dist/bin/next");
