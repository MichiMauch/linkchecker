import { AutoRefresh } from "./auto-refresh.js";
import { ExportFixes } from "./export-fixes.js";
import {
  BrokenLinksTable,
  groupByTarget,
  isInternalFinding,
  LangBreakdown,
  NewCrawlForm,
  RunsTable,
  RunSummary,
  SoftErrorTable,
  UncheckableLinks,
} from "./components.js";
import {
  getBrokenLinks,
  getDeadSitemapUrls,
  getFixViews,
  getInboundLinkCounts,
  getLatestRun,
  getRecentRuns,
  getRedirectPairs,
  getRunPageCount,
  getSitemapTruncation,
  getSoftErrors,
  getUncheckableLinks,
} from "./lib/queries.js";

// Always read fresh from the DB — never prerender at build time.
export const dynamic = "force-dynamic";

export default async function HomePage() {
  const latest = await getLatestRun();

  return (
    <>
      <h2>Neuen Crawl starten</h2>
      <NewCrawlForm />

      {latest ? <LatestRun /> : <EmptyState />}
    </>
  );
}

function EmptyState() {
  return (
    <>
      <h2>Übersicht</h2>
      <div className="empty">Noch keine Läufe. Starte oben deinen ersten Crawl.</div>
    </>
  );
}

async function LatestRun() {
  const latest = (await getLatestRun())!;
  const running = latest.status === "running";
  const [broken, uncheckable, softErrors, deadSitemap, truncation, runs, liveCount] =
    await Promise.all([
      getBrokenLinks(latest.id),
      getUncheckableLinks(latest.id),
      getSoftErrors(latest.id),
      getDeadSitemapUrls(latest.id),
      getSitemapTruncation(latest.id),
      getRecentRuns(20),
      running ? getRunPageCount(latest.id) : Promise.resolve(latest.pagesCrawled),
    ]);
  const inbound = await getInboundLinkCounts(latest.id, softErrors.map((f) => f.url));
  const fixes = await getFixViews(latest.id);
  const redirects = await getRedirectPairs(latest.id);
  const internalBroken = broken.filter(isInternalFinding);
  const externalBroken = broken.filter((f) => !isInternalFinding(f));
  const internalCount = groupByTarget(internalBroken).length;
  const externalCount = groupByTarget(externalBroken).length;
  const brokenCount = internalCount + externalCount;

  return (
    <>
      {running ? <AutoRefresh /> : null}

      <h2>Letzter Lauf — {latest.baseUrl}</h2>
      <RunSummary
        run={latest}
        broken={brokenCount}
        pages={liveCount}
        brokenInternal={internalCount}
        brokenExternal={externalCount}
      />

      {truncation ? <p className="notice warn">{truncation.message}</p> : null}

      {deadSitemap.length > 0 ? (
        <>
          <h2>Tote Sitemap-URLs ({deadSitemap.length})</h2>
          <p className="muted">In der Sitemap gelistet, liefern aber 4xx — entferne sie oder repariere die Seite.</p>
          <BrokenLinksTable findings={deadSitemap} emptyLabel="" />
        </>
      ) : null}

      <h2>Kaputte Links ({brokenCount})</h2>
      <LangBreakdown findings={broken} />
      <h3>Intern ({internalCount})</h3>
      <BrokenLinksTable
        findings={internalBroken}
        emptyLabel="Keine internen kaputten Links. 🎉"
        runId={latest.id}
        fixes={fixes}
      />
      <h3>Extern ({externalCount})</h3>
      <BrokenLinksTable findings={externalBroken} emptyLabel="Keine externen kaputten Links." />

      {redirects.length > 0 ? (
        <>
          <h2>Redirect-Export ({redirects.length})</h2>
          <p className="muted">Aus den übernommenen Fixes — wähle das Format für deinen Stack.</p>
          <ExportFixes pairs={redirects} />
        </>
      ) : null}

      <h2>Soft 404 ({softErrors.length})</h2>
      <SoftErrorTable findings={softErrors} inbound={inbound} />

      <UncheckableLinks findings={uncheckable} />

      <h2>Alle Läufe</h2>
      <RunsTable runs={runs} />
    </>
  );
}
