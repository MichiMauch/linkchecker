"use client";

import { useState, useTransition } from "react";
import { acceptFixAction, rejectFixAction, suggestFixAction } from "./fix-actions.js";
import type { FixView } from "./fix-types.js";

export function FixSuggestion({
  runId,
  target,
  initial,
}: {
  runId: string;
  target: string;
  initial: FixView | null;
}) {
  const [fix, setFix] = useState<FixView | null>(initial);
  const [pending, startTransition] = useTransition();

  const run = (fn: () => Promise<FixView | null>) => startTransition(async () => setFix(await fn()));

  if (!fix) {
    return (
      <button className="fix-btn" disabled={pending} onClick={() => run(() => suggestFixAction(runId, target))}>
        {pending ? "…" : "Fix vorschlagen"}
      </button>
    );
  }

  return (
    <div className="fix">
      {fix.suggestedUrl ? (
        <div>
          <a className="url" href={fix.suggestedUrl} target="_blank" rel="noreferrer">
            {fix.suggestedUrl}
          </a>{" "}
          {fix.confidence != null ? <span className="badge status">{Math.round(fix.confidence * 100)}%</span> : null}
        </div>
      ) : (
        <span className="muted">kein guter Treffer</span>
      )}
      {fix.reason ? <div className="muted">{fix.reason}</div> : null}

      <div className="fix-actions">
        {fix.status === "accepted" ? (
          <span className="badge run-done">übernommen</span>
        ) : fix.status === "rejected" ? (
          <span className="badge run-failed">verworfen</span>
        ) : fix.suggestedUrl ? (
          <>
            <button className="fix-btn" disabled={pending} onClick={() => run(() => acceptFixAction(runId, target))}>
              ✓ Übernehmen
            </button>
            <button className="fix-btn ghost" disabled={pending} onClick={() => run(() => rejectFixAction(runId, target))}>
              ✗ Verwerfen
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
}
