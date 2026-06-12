import * as cheerio from "cheerio";
import {
  SoftErrorProbe,
  type Analyzer,
  type AnalyzerResult,
  type CrawlContext,
  type FetchedPage,
  type Finding,
} from "@linkchecker/core";
import { classifySoftError, isLlmEnabled } from "@linkchecker/ai";

export interface Soft404Options {
  /** Use the LLM for the ambiguous band (default true; auto-off without API key). */
  useLlm?: boolean;
  /** Max LLM classification calls per origin (cost guard, default 30). */
  perOriginLlmCap?: number;
  /** Jaccard threshold against the 404 template to call it a soft-404 (default 0.8). */
  templateThreshold?: number;
}

interface Features {
  title: string;
  text: string;
  len: number;
}

const ERROR_RE =
  /\b(404|not found|page not found|page doesn'?t exist|does not exist|nicht gefunden|seite (existiert nicht|wurde nicht gefunden)|nicht verf[üu]gbar|gibt es (nicht|leider))\b/i;

/**
 * Detects "soft 404s": pages served with a 200 status that are really error /
 * "not found" templates. Runs on every crawled (OK) page — its body is already
 * fetched, so no extra requests except one probe per origin.
 *
 * Pipeline (cheap → expensive, early exit):
 *   1. template match against the origin's probed 404 page  (free)
 *   2. error phrase in the title on a short page             (free)
 *   3. LLM classification for the ambiguous band             (capped, optional)
 */
export class Soft404Analyzer implements Analyzer {
  readonly name = "soft-404";

  private readonly probe = new SoftErrorProbe();
  private readonly probeFeatures = new Map<string, Features | null>();
  private readonly llmUsed = new Map<string, number>();
  private readonly useLlm: boolean;
  private readonly cap: number;
  private readonly templateThreshold: number;

  constructor(opts: Soft404Options = {}) {
    this.useLlm = opts.useLlm ?? true;
    this.cap = opts.perOriginLlmCap ?? 30;
    this.templateThreshold = opts.templateThreshold ?? 0.8;
  }

  async analyze(page: FetchedPage, _ctx: CrawlContext): Promise<AnalyzerResult> {
    const findings: Finding[] = [];
    const origin = safeOrigin(page.finalUrl);
    if (!origin || !page.body) return { findings, discoveredUrls: [] };

    const feat = extractFeatures(page.body);
    const templateFeat = await this.getProbeFeatures(origin);

    const templateSim = templateFeat ? jaccard(feat, templateFeat) : 0;
    const templateMatch = templateSim >= this.templateThreshold;
    const errorPhrase = feat.len < 800 && ERROR_RE.test(feat.title);

    let verdict: { confidence: number; reason: string; method: string } | null = null;

    if (templateMatch) {
      verdict = { confidence: 0.9, reason: "Entspricht der 404-Vorlage der Seite", method: "template" };
    } else if (errorPhrase) {
      verdict = { confidence: 0.85, reason: "Titel deutet auf Fehlerseite hin", method: "heuristic" };
    } else if (this.isAmbiguous(feat, templateSim) && this.useLlm && isLlmEnabled() && this.budgetLeft(origin)) {
      this.bump(origin);
      const r = await classifySoftError({
        url: page.url,
        title: feat.title,
        textSnippet: feat.text.slice(0, 1500),
      });
      if (r?.isSoftError && r.confidence >= 0.6) {
        verdict = { confidence: r.confidence, reason: r.reason || "Vom Modell als Fehlerseite erkannt", method: "llm" };
      }
    }

    if (verdict) {
      findings.push({
        analyzer: this.name,
        type: "soft-404",
        severity: "error",
        message: `Soft 404 (HTTP ${page.status}, sieht aus wie Fehlerseite): ${page.url}`,
        url: page.url,
        detail: {
          confidence: verdict.confidence,
          reason: verdict.reason,
          method: verdict.method,
          status: page.status,
          templateSimilarity: Math.round(templateSim * 100) / 100,
        },
      });
    }

    return { findings, discoveredUrls: [] };
  }

  /** Only spend an LLM call when there is some suspicion but no certainty. */
  private isAmbiguous(feat: Features, templateSim: number): boolean {
    return feat.len < 250 || (templateSim >= 0.55 && templateSim < this.templateThreshold);
  }

  private async getProbeFeatures(origin: string): Promise<Features | null> {
    if (this.probeFeatures.has(origin)) return this.probeFeatures.get(origin)!;
    const probe = await this.probe.get(origin);
    const feat = probe.status === 200 && probe.html ? extractFeatures(probe.html) : null;
    this.probeFeatures.set(origin, feat);
    return feat;
  }

  private budgetLeft(origin: string): boolean {
    return (this.llmUsed.get(origin) ?? 0) < this.cap;
  }

  private bump(origin: string): void {
    const n = (this.llmUsed.get(origin) ?? 0) + 1;
    this.llmUsed.set(origin, n);
    if (n === this.cap) {
      console.warn(`[soft-404] LLM cap (${this.cap}) reached for ${origin}; further ambiguous pages skip the LLM.`);
    }
  }
}

function safeOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function extractFeatures(html: string): Features {
  const $ = cheerio.load(html);
  $("script, style, noscript, svg, nav, header, footer").remove();
  const title = ($("title").first().text() || $("h1").first().text() || "").replace(/\s+/g, " ").trim().slice(0, 200);
  const text = $("body").text().replace(/\s+/g, " ").trim();
  return { title, text, len: text.length };
}

function shingles(text: string): Set<string> {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  const out = new Set<string>();
  if (words.length < 3) {
    if (words.length) out.add(words.join(" "));
    return out;
  }
  for (let i = 0; i + 3 <= words.length; i++) out.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
  return out;
}

function jaccard(a: Features, b: Features): number {
  const A = shingles(a.text);
  const B = shingles(b.text);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}
