import Link from "next/link";
import { startCrawl } from "./actions.js";
import type { Finding, Run } from "./lib/queries.js";

export function NewCrawlForm() {
  return (
    <form action={startCrawl} className="newrun">
      <input
        type="text"
        name="target"
        required
        placeholder="eure-seite.ch   oder   www.eure-seite.ch   oder   eure-seite.ch/sitemap.xml"
        aria-label="URL oder Sitemap"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
      />
      <input
        type="number"
        name="max"
        defaultValue={500}
        min={1}
        aria-label="Max. Seiten"
        title="Maximale Anzahl Seiten"
      />
      <button type="submit">Crawl starten</button>
    </form>
  );
}

export function StatusBadge({ status }: { status: string }) {
  return <span className={`badge run-${status}`}>{status}</span>;
}

export function fmtDate(d: Date | null): string {
  if (!d) return "–";
  return new Date(d).toLocaleString("de-CH", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function detailString(detail: Record<string, unknown> | null, key: string): string | undefined {
  if (!detail) return undefined;
  const v = detail[key];
  return v == null ? undefined : String(v);
}

export function RunSummary({
  run,
  broken,
  pages,
  brokenInternal,
  brokenExternal,
}: {
  run: Run;
  broken: number;
  pages?: number;
  brokenInternal?: number;
  brokenExternal?: number;
}) {
  const pagesCrawled = pages ?? run.pagesCrawled;
  const running = run.status === "running";
  return (
    <div className="cards">
      <div className="card">
        <div className="label">Gestartet</div>
        <div className="value" style={{ fontSize: "1.1rem", fontWeight: 500 }}>
          {fmtDate(run.startedAt)}
        </div>
      </div>
      <div className="card">
        <div className="label">Seiten geprüft</div>
        <div className="value">
          {pagesCrawled.toLocaleString("de-CH")}
          {running ? <span className="spin" aria-hidden /> : null}
        </div>
      </div>
      <div className="card">
        <div className="label">Kaputte Links</div>
        <div className={`value ${broken > 0 ? "error" : "ok"}`}>{broken}</div>
        {brokenInternal !== undefined ? (
          <div className="muted" style={{ fontSize: "0.8rem", marginTop: "0.2rem" }}>
            {brokenInternal} intern · {brokenExternal} extern
          </div>
        ) : null}
      </div>
      <div className="card">
        <div className="label">Status</div>
        <div className="value" style={{ fontSize: "1.1rem", fontWeight: 500 }}>
          <StatusBadge status={run.status} />
        </div>
      </div>
    </div>
  );
}

interface GroupedLink {
  target: string;
  status?: string;
  error?: string;
  sources: string[];
}

/** Collapse per-page findings into one row per unique target link. */
export function groupByTarget(findings: Finding[]): GroupedLink[] {
  const map = new Map<string, GroupedLink>();
  for (const f of findings) {
    const target = detailString(f.detail, "target") ?? f.url;
    let g = map.get(target);
    if (!g) {
      g = {
        target,
        status: detailString(f.detail, "status"),
        error: detailString(f.detail, "error"),
        sources: [],
      };
      map.set(target, g);
    }
    if (!g.sources.includes(f.url)) g.sources.push(f.url);
  }
  return [...map.values()].sort((a, b) => b.sources.length - a.sources.length);
}

function LinkRows({ groups, badgeClass }: { groups: GroupedLink[]; badgeClass: string }) {
  return (
    <table>
      <thead>
        <tr>
          <th style={{ width: "70px" }}>Status</th>
          <th>Ziel-Link</th>
          <th style={{ width: "160px" }}>Betroffene Seiten</th>
        </tr>
      </thead>
      <tbody>
        {groups.map((g) => (
          <tr key={g.target}>
            <td>
              <span className={`badge ${badgeClass}`}>
                {g.status && g.status !== "0" ? g.status : "ERR"}
              </span>
            </td>
            <td>
              <span className="url">{g.target}</span>
              {g.error ? <div className="muted">{g.error}</div> : null}
            </td>
            <td>
              <details>
                <summary>
                  {g.sources.length} Seite{g.sources.length > 1 ? "n" : ""}
                </summary>
                <ul className="sources">
                  {g.sources.map((s) => (
                    <li key={s}>
                      <a className="url" href={s} target="_blank" rel="noreferrer">
                        {s}
                      </a>
                    </li>
                  ))}
                </ul>
              </details>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** A finding is internal when the link target lives on the crawled site. */
export function isInternalFinding(f: Finding): boolean {
  return f.detail?.internal === true;
}

export function BrokenLinksTable({
  findings,
  emptyLabel = "Keine kaputten Links gefunden. 🎉",
}: {
  findings: Finding[];
  emptyLabel?: string;
}) {
  const groups = groupByTarget(findings);
  if (groups.length === 0) {
    return <div className="empty">{emptyLabel}</div>;
  }
  return <LinkRows groups={groups} badgeClass="error" />;
}

/** Bot-blocked / unreachable links — shown separately, collapsed by default. */
export function UncheckableLinks({ findings }: { findings: Finding[] }) {
  const groups = groupByTarget(findings);
  if (groups.length === 0) return null;
  return (
    <details className="uncheckable">
      <summary>
        Nicht prüfbar ({groups.length}) — Bot-Schutz (z.B. LinkedIn) oder Timeouts.{" "}
        <span className="muted">Nicht zwingend kaputt.</span>
      </summary>
      <div style={{ marginTop: "0.75rem" }}>
        <LinkRows groups={groups} badgeClass="warn" />
      </div>
    </details>
  );
}

export function RunsTable({ runs }: { runs: Run[] }) {
  if (runs.length === 0) {
    return <div className="empty">Noch keine Läufe. Starte einen Crawl mit `npm run crawl`.</div>;
  }
  return (
    <table>
      <thead>
        <tr>
          <th>Gestartet</th>
          <th>Basis-URL</th>
          <th style={{ textAlign: "right" }}>Seiten</th>
          <th style={{ textAlign: "right" }}>Findings</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        {runs.map((r) => (
          <tr key={r.id}>
            <td>
              <Link href={`/runs/${r.id}`}>{fmtDate(r.startedAt)}</Link>
            </td>
            <td className="url">{r.baseUrl}</td>
            <td style={{ textAlign: "right" }}>{r.pagesCrawled.toLocaleString("de-CH")}</td>
            <td style={{ textAlign: "right" }}>{r.findingsCount.toLocaleString("de-CH")}</td>
            <td>{r.status}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
