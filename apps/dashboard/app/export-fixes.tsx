"use client";

import { useState } from "react";
import { FORMATS, formatRedirects, type RedirectFormat, type RedirectPair } from "./lib/redirects.js";

export function ExportFixes({ pairs }: { pairs: RedirectPair[] }) {
  const [format, setFormat] = useState<RedirectFormat>("nextjs");
  const [copied, setCopied] = useState(false);

  const text = formatRedirects(pairs, format);
  const meta = FORMATS.find((f) => f.value === format)!;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — user can select the textarea manually */
    }
  };

  const download = () => {
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = meta.filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="export">
      <div className="export-bar">
        <select value={format} onChange={(e) => setFormat(e.target.value as RedirectFormat)}>
          {FORMATS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
        <button className="fix-btn" onClick={copy}>
          {copied ? "Kopiert ✓" : "Kopieren"}
        </button>
        <button className="fix-btn ghost" onClick={download}>
          Download
        </button>
        <span className="muted">{pairs.length} Redirect{pairs.length > 1 ? "s" : ""}</span>
      </div>
      <textarea className="export-text" readOnly value={text} rows={Math.min(pairs.length + 2, 16)} />
    </div>
  );
}
