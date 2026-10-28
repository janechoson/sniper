import type { NextConfig } from "next";
const config: NextConfig = {
  poweredByHeader: false,
  // Giữ hướng dẫn tác nhân bằng tiếng Việt, không tự chèn lại khối tiếng Anh.
  agentRules: false,
};
export default config;
