import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Link Checker",
  description: "Broken-link monitoring dashboard",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="de">
      <body>
        <header className="site">
          <div className="container">
            <h1>
              <Link href="/" style={{ color: "var(--text)" }}>
                Link Checker
              </Link>
            </h1>
            <span className="tag">Broken-Link-Monitoring</span>
          </div>
        </header>
        <main className="container">{children}</main>
      </body>
    </html>
  );
}
