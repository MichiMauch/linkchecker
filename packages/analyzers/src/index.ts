import type { Analyzer } from "@linkchecker/core";
import { LinkChecker } from "./link-checker.js";
import { Soft404Analyzer, type Soft404Options } from "./soft-404.js";

export * from "./link-checker.js";
export * from "./soft-404.js";

export interface AnalyzerOptions {
  soft404?: Soft404Options;
}

/** The standard analyzer set used by the crawler, worker, and dashboard. */
export function defaultAnalyzers(opts: AnalyzerOptions = {}): Analyzer[] {
  return [new LinkChecker(), new Soft404Analyzer(opts.soft404)];
}
