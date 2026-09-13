import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Distribution-center twin",
  description:
    "A discrete-event digital twin of candystore_mcp's two distribution centers: layout and slotting, inventory, order flow, labor and workforce planning, and disruptions, served as an MCP server.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
