import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { authEnabled, COOKIE_NAME, sessionToken } from "./lib/auth.js";
import { logout } from "./login/actions.js";
import "./globals.css";

export const metadata: Metadata = {
  title: "Link Checker",
  description: "Broken-link monitoring dashboard",
};

async function isLoggedIn(): Promise<boolean> {
  if (!authEnabled()) return false;
  const cookie = (await cookies()).get(COOKIE_NAME)?.value;
  return !!cookie && cookie === (await sessionToken());
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const loggedIn = await isLoggedIn();
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
            {loggedIn ? (
              <form action={logout} style={{ marginLeft: "auto" }}>
                <button className="fix-btn ghost" type="submit">
                  Logout
                </button>
              </form>
            ) : null}
          </div>
        </header>
        <main className="container">{children}</main>
      </body>
    </html>
  );
}
