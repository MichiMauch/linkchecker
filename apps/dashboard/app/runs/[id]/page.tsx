import Link from "next/link";
import { notFound } from "next/navigation";
import { AutoRefresh } from "../../auto-refresh.js";
import {
  BrokenLinksTable,
  groupByTarget,
  isInternalFinding,
  RunSummary,
  UncheckableLinks,
} from "../../components.js";
import {
  getBrokenLinks,
  getRun,
  getRunPageCount,
  getUncheckableLinks,
} from "../../lib/queries.js";

export const dynamic = "force-dynamic";

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const run = await getRun(id);
  if (!run) notFound();

  const running = run.status === "running";
  const [broken, uncheckable, liveCount] = await Promise.all([
    getBrokenLinks(run.id),
    getUncheckableLinks(run.id),
    running ? getRunPageCount(run.id) : Promise.resolve(run.pagesCrawled),
  ]);
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

      <h2>Kaputte Links ({brokenCount})</h2>
      <h3>Intern ({internalCount})</h3>
      <BrokenLinksTable findings={internalBroken} emptyLabel="Keine internen kaputten Links. 🎉" />
      <h3>Extern ({externalCount})</h3>
      <BrokenLinksTable findings={externalBroken} emptyLabel="Keine externen kaputten Links." />
      <UncheckableLinks findings={uncheckable} />
    </>
  );
}
