import Link from "next/link";
export default function NotFound() {
  return (
    <main>
      <h1>Không tìm thấy trang</h1>
      <p>Địa chỉ bạn truy cập không tồn tại.</p>
      <Link href="/">Trở về bảng điều khiển</Link>
    </main>
  );
}
