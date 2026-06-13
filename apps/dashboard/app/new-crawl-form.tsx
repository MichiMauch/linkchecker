"use client";

import { useState } from "react";
import { inspectSite, startCrawl, type SiteInspection } from "./actions.js";

/**
 * Two-step crawl wizard:
 *  1. Enter a domain or sitemap → "Sitemap prüfen" inspects via robots.txt.
 *  2. Show what was found (languages, sources) and offer matching options —
 *     language checkboxes, subset, date window — then start the crawl.
 * This guides users who don't know the site's structure or the tool.
 */
export function NewCrawlForm() {
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState<SiteInspection | null>(null);
  const [subset, setSubset] = useState("none");
  const [langs, setLangs] = useState<string[]>([]);

  async function inspect() {
    const t = target.trim();
    if (!t || busy) return;
    setBusy(true);
    try {
      const res = await inspectSite(t);
      setLangs([]);
      setSubset("none");
      setInfo(res);
    } finally {
      setBusy(false);
    }
  }

  function toggleLang(l: string) {
    setLangs((cur) => (cur.includes(l) ? cur.filter((x) => x !== l) : [...cur, l]));
  }

  // Step 1 — enter target, inspect.
  if (!info) {
    return (
      <div className="newrun">
        <div className="field field-grow">
          <label htmlFor="target">URL oder Sitemap</label>
          <input
            id="target"
            type="text"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void inspect();
              }
            }}
            required
            placeholder="eure-seite.ch   oder   eure-seite.ch/sitemap.xml"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
        </div>
        <div className="field field-action">
          <button type="button" onClick={() => void inspect()} disabled={busy}>
            {busy ? "Prüfe Sitemap …" : "Sitemap prüfen"}
          </button>
        </div>
      </div>
    );
  }

  // Step 2 — configure based on what was found, then start.
  return (
    <form action={startCrawl} className="newrun">
      <input type="hidden" name="target" value={info.target} />
      <input type="hidden" name="langs" value={langs.join(",")} />

      <div className="field field-grow">
        <label>Ziel</label>
        <div className="inspect-summary">
          <span className="url">{info.target}</span>
          <button type="button" className="link-btn" onClick={() => setInfo(null)}>
            ändern
          </button>
          <div className={info.found ? "muted" : "warn"}>
            {info.found
              ? `✓ Sitemap gefunden — ${info.sources} Quelle${info.sources > 1 ? "n" : ""}` +
                (info.total != null ? `, ${info.total.toLocaleString("de-CH")} URLs` : "") +
                (info.languages.length ? `, Sprachen: ${info.languages.join(", ")}` : "")
              : "Keine Sitemap gefunden — die Seite wird direkt gecrawlt (Links verfolgen)."}
          </div>
        </div>
      </div>

      {info.languages.length > 0 ? (
        <div className="field">
          <label>Sprachen</label>
          <div className="lang-checks">
            {info.languages.map((l) => (
              <label key={l} className="lang-check">
                <input type="checkbox" checked={langs.includes(l)} onChange={() => toggleLang(l)} /> {l}
              </label>
            ))}
          </div>
          <span className="muted">keine = alle</span>
        </div>
      ) : (
        <div className="field">
          <label htmlFor="langsText">Sprachen</label>
          <input
            id="langsText"
            type="text"
            placeholder="alle"
            title="z. B. „fr, it“ — leer = alle"
            onChange={(e) => setLangs(e.target.value.split(/[\s,]+/).filter(Boolean))}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            style={{ width: "100px" }}
          />
        </div>
      )}

      <div className="field">
        <label htmlFor="max">Max. Seiten</label>
        <input
          id="max"
          type="number"
          name="max"
          defaultValue={500}
          min={1}
          title="Maximale Anzahl Seiten. Bei einer Teilmenge unten wird dieser Wert ignoriert."
        />
      </div>

      <div className="field">
        <label htmlFor="subset">Teilmenge</label>
        <select id="subset" name="subset" value={subset} onChange={(e) => setSubset(e.target.value)}>
          <option value="none">Alle Seiten</option>
          <option value="newest">Nur neueste …</option>
          <option value="oldest">Nur älteste …</option>
        </select>
      </div>

      {subset !== "none" ? (
        <div className="field">
          <label htmlFor="subsetN">Anzahl</label>
          <input id="subsetN" type="number" name="subsetN" defaultValue={100} min={1} />
        </div>
      ) : null}

      <div className="field">
        <label htmlFor="from">Geändert von</label>
        <input id="from" type="date" name="from" title="Nur Seiten mit <lastmod> ab diesem Datum" />
      </div>

      <div className="field">
        <label htmlFor="to">Geändert bis</label>
        <input id="to" type="date" name="to" title="Nur Seiten mit <lastmod> bis zu diesem Datum" />
      </div>

      <div className="field field-action">
        <button type="submit">Crawl starten</button>
      </div>
    </form>
  );
}
