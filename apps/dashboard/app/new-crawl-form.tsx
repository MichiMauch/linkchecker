"use client";

import { useState } from "react";
import { startCrawl } from "./actions.js";

/**
 * Crawl form. A bare domain is auto-resolved to its sitemap(s) server-side, so
 * the subset/date/language options apply whether you enter a domain or a `.xml`.
 * The "Anzahl" field only appears once a top-N mode is selected.
 */
export function NewCrawlForm() {
  const [subset, setSubset] = useState("none");

  return (
    <>
      <form action={startCrawl} className="newrun">
        <div className="field field-grow">
          <label htmlFor="target">URL oder Sitemap</label>
          <input
            id="target"
            type="text"
            name="target"
            required
            placeholder="eure-seite.ch   oder   eure-seite.ch/sitemap.xml"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
        </div>

        <div className="field">
          <label htmlFor="max">Max. Seiten</label>
          <input
            id="max"
            type="number"
            name="max"
            defaultValue={500}
            min={1}
            title="Maximale Anzahl Seiten (ganze Site/Sitemap). Bei einer Teilmenge unten wird dieser Wert ignoriert."
          />
        </div>

        <div className="field">
          <label htmlFor="langs">Sprachen</label>
          <input
            id="langs"
            type="text"
            name="langs"
            placeholder="alle"
            title="Nur diese Sprachen prüfen (aus dem URL-Pfad /xx/), z. B. „fr, it“. Leer = alle."
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            style={{ width: "100px" }}
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
      <p className="muted form-hint">
        Teilmenge & Datum nutzen die <code>&lt;lastmod&gt;</code>-Angaben der Sitemap. Bei einer
        Domain wird die Sitemap automatisch über die <code>robots.txt</code> gefunden.
      </p>
    </>
  );
}
