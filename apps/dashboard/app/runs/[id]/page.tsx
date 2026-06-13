import Link from "next/link";
import { notFound } from "next/navigation";
import { AutoRefresh } from "../../auto-refresh.js";
import { ExportFixes } from "../../export-fixes.js";
import {
  BrokenLinksTable,
  groupByTarget,
  isInternalFinding,
  LangBreakdown,
  RunSummary,
  SoftErrorTable,
  UncheckableLinks,
} from "../../components.js";
import {
  getBrokenLinks,
  getDeadSitemapUrls,
  getFixViews,
  getInboundLinkCounts,
  getRedirectPairs,
  getRun,
  getRunPageCount,
  getSitemapTruncation,
  getSoftErrors,
  getUncheckableLinks,
} from "../../lib/queries.js";

export const dynamic = "force-dynamic";

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const run = await getRun(id);
  if (!run) notFound();

  const running = run.status === "running";
  const [broken, uncheckable, softErrors, deadSitemap, truncation, liveCount] = await Promise.all([
    getBrokenLinks(run.id),
    getUncheckableLinks(run.id),
    getSoftErrors(run.id),
    getDeadSitemapUrls(run.id),
    getSitemapTruncation(run.id),
    running ? getRunPageCount(run.id) : Promise.resolve(run.pagesCrawled),
  ]);
  const inbound = await getInboundLinkCounts(run.id, softErrors.map((f) => f.url));
  const fixes = await getFixViews(run.id);
  const redirects = await getRedirectPairs(run.id);
  const internalBroken = broken.filter(isInternalFinding);
  const externalBroken = broken.filter((f) => !isInternalFinding(f));
  const internalCount = groupByTarget(internalBroken).length;
  const externalCount = groupByTarget(externalBroken).length;
  const brokenCount = internalCount + externalCount;

  return (
    <>
      {running ? <AutoRefresh /> : null}

      <Link className="back" href="/">
        ← Zurück zur Übersicht
      </Link>
      <h2>Lauf {run.baseUrl}</h2>
      <RunSummary
        run={run}
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
        runId={run.id}
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
    </>
  );
}
