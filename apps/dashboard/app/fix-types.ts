import type { LinkFix } from "@linkchecker/db";

/** Client-serializable view of a cached fix suggestion. */
export interface FixView {
  suggestedUrl: string | null;
  confidence: number | null;
  reason: string | null;
  method: string;
  status: string;
}

export function toFixView(f: LinkFix): FixView {
  return {
    suggestedUrl: f.suggestedUrl,
    confidence: f.confidence,
    reason: f.reason,
    method: f.method,
    status: f.status,
  };
}
