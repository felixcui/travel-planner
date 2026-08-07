import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "去野 · 智能自驾旅行规划",
  description: "把想去的地方，排成真正走得通的旅程。",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
