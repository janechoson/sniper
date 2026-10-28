import type { ReactNode } from "react";
import { APP_NAME } from "../components/brand";
import "./globals.css";
export const metadata = {
  title: `${APP_NAME} · Terminal giao dịch đa chuỗi`,
  description:
    "Terminal cục bộ theo dõi dữ liệu blockchain thật, tín hiệu Jev, rủi ro và vị thế giao dịch đa chuỗi.",
};
export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="vi">
      <body>{children}</body>
    </html>
  );
}
