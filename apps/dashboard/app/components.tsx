import Link from "next/link";
import { detectLang } from "@linkchecker/core";
import { FixSuggestion } from "./fix-suggestion.js";
import type { FixView } from "./fix-types.js";
import type { Finding, Run } from "./lib/queries.js";

export { NewCrawlForm } from "./new-crawl-form.js";

/**
 * Per-language breakdown of findings, by the language of the page each finding
 * is on (URL path /xx/). Shown only when more than one language is present —
 * otherwise it adds no information.
 */
export function LangBreakdown({ findings }: { findings: Finding[] }) {
  const counts = new Map<string, number>();
  for (const f of findings) {
    const lang = detectLang(f.url) ?? "neutral";
    counts.set(lang, (counts.get(lang) ?? 0) + 1);
  }
  if (counts.size <= 1) return null;
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return (
    <p className="lang-breakdown muted">
      Nach Sprache:{" "}
      {sorted.map(([lang, n], i) => (
        <span key={lang}>
          {i > 0 ? " · " : ""}
          <span className="badge status">{lang}</span> {n}
        </span>
      ))}
    </p>
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

function LinkRows({
  groups,
  badgeClass,
  runId,
  fixes,
}: {
  groups: GroupedLink[];
  badgeClass: string;
  runId?: string;
  fixes?: Record<string, FixView>;
}) {
  const showFix = !!runId;
  return (
    <table>
      <thead>
        <tr>
          <th style={{ width: "70px" }}>Status</th>
          <th>Ziel-Link</th>
          <th style={{ width: "140px" }}>Betroffene Seiten</th>
          {showFix ? <th style={{ width: "280px" }}>Fix-Vorschlag</th> : null}
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
            {showFix ? (
              <td>
                <FixSuggestion runId={runId!} target={g.target} initial={fixes?.[g.target] ?? null} />
              </td>
            ) : null}
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
  runId,
  fixes,
}: {
  findings: Finding[];
  emptyLabel?: string;
  /** When set, each row gets an on-demand "Fix vorschlagen" action. */
  runId?: string;
  fixes?: Record<string, FixView>;
}) {
  const groups = groupByTarget(findings);
  if (groups.length === 0) {
    return <div className="empty">{emptyLabel}</div>;
  }
  return <LinkRows groups={groups} badgeClass="error" runId={runId} fixes={fixes} />;
}

function detailNumber(detail: Record<string, unknown> | null, key: string): number | undefined {
  const v = detail?.[key];
  return typeof v === "number" ? v : undefined;
}

const METHOD_LABEL: Record<string, string> = {
  template: "404-Vorlage",
  heuristic: "Heuristik",
  llm: "KI (Claude)",
};

/** Pages that return 200 but are really "not found" templates. */
export function SoftErrorTable({
  findings,
  inbound,
}: {
  findings: Finding[];
  inbound: Record<string, number>;
}) {
  if (findings.length === 0) {
    return <div className="empty">Keine Soft-404-Seiten gefunden. 🎉</div>;
  }
  return (
    <table>
      <thead>
        <tr>
          <th style={{ width: "90px" }}>Konfidenz</th>
          <th>Seite (liefert 200, ist aber Fehlerseite)</th>
          <th style={{ width: "150px" }}>Erkannt durch</th>
          <th style={{ width: "120px" }}>Eingehende Links</th>
        </tr>
      </thead>
      <tbody>
        {findings.map((f) => {
          const conf = detailNumber(f.detail, "confidence");
          const method = detailString(f.detail, "method") ?? "";
          const reason = detailString(f.detail, "reason");
          const count = inbound[f.url] ?? 0;
          return (
            <tr key={f.id}>
              <td>
                <span className="badge error">{conf != null ? `${Math.round(conf * 100)}%` : "—"}</span>
              </td>
              <td>
                <a className="url" href={f.url} target="_blank" rel="noreferrer">
                  {f.url}
                </a>
                {reason ? <div className="muted">{reason}</div> : null}
              </td>
              <td>
                <span className="badge status">{METHOD_LABEL[method] ?? method}</span>
              </td>
              <td>{count > 0 ? `${count} Link${count > 1 ? "s" : ""}` : <span className="muted">—</span>}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** Not-confirmed-dead links — shown separately, collapsed by default. */
export function UncheckableLinks({ findings }: { findings: Finding[] }) {
  const groups = groupByTarget(findings);
  if (groups.length === 0) return null;
  return (
    <details className="uncheckable">
      <summary>
        Nicht prüfbar / sonstige ({groups.length}) — Bot-Schutz (z.B. LinkedIn),
        Timeouts, Serverfehler (5xx), tote Sprungmarken oder hreflang-Verweise.{" "}
        <span className="muted">Keine echten 404.</span>
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
