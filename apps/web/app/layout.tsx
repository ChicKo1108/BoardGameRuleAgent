import type { Metadata } from "next";
import type { ReactNode } from "react";
export const metadata: Metadata = { title: "桌游规则助手", description: "桌游知识库与 RAG 工程" };
export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
