import type { Metadata } from "next";
import "./globals.css";
import SportNav from "@/components/SportNav";
import { DataSourceProvider } from "@/components/DataSourceContext";

export const metadata: Metadata = {
  title: "Sports Betting Dashboard",
  description: "MLB & WNBA sports betting data — Polymarket + Kalshi",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full">
      <body className="min-h-full">
        <DataSourceProvider>
          <SportNav />
          {children}
        </DataSourceProvider>
      </body>
    </html>
  );
}
