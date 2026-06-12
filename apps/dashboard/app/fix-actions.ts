"use server";

import { suggestFix } from "@linkchecker/ai";
import { getAnchorTexts, getCachedFix, getValidPages, saveFix, setFixStatus } from "@linkchecker/db";
import { toFixView, type FixView } from "./fix-types.js";

/** Suggest a fix for one broken internal link (cached; one LLM call on miss). */
export async function suggestFixAction(runId: string, target: string): Promise<FixView> {
  const cached = await getCachedFix(runId, target);
  if (cached) return toFixView(cached);

  const [candidates, anchorTexts] = await Promise.all([
    getValidPages(runId),
    getAnchorTexts(runId, target),
  ]);
  const result = await suggestFix({ brokenUrl: target, anchorTexts, candidates });
  const saved = await saveFix(runId, target, result);
  return toFixView(saved);
}

export async function acceptFixAction(runId: string, target: string): Promise<FixView | null> {
  const row = await setFixStatus(runId, target, "accepted");
  return row ? toFixView(row) : null;
}

export async function rejectFixAction(runId: string, target: string): Promise<FixView | null> {
  const row = await setFixStatus(runId, target, "rejected");
  return row ? toFixView(row) : null;
}
