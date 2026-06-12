/** Pure redirect-config generators — safe to import in client components. */

export interface RedirectPair {
  from: string;
  to: string;
}

export type RedirectFormat = "nextjs" | "nginx" | "apache" | "netlify" | "csv";

export const FORMATS: Array<{ value: RedirectFormat; label: string; filename: string }> = [
  { value: "nextjs", label: "Next.js (next.config)", filename: "redirects.next.txt" },
  { value: "nginx", label: "nginx", filename: "redirects.nginx.conf" },
  { value: "apache", label: "Apache (.htaccess)", filename: ".htaccess" },
  { value: "netlify", label: "Netlify (_redirects)", filename: "_redirects" },
  { value: "csv", label: "CSV (WordPress / Drupal Redirect)", filename: "redirects.csv" },
];

export function formatRedirects(pairs: RedirectPair[], format: RedirectFormat): string {
  if (pairs.length === 0) return "";
  switch (format) {
    case "nextjs":
      return [
        "// Add these entries to the array returned by redirects() in next.config:",
        ...pairs.map(
          (p) =>
            `{ source: ${JSON.stringify(p.from)}, destination: ${JSON.stringify(p.to)}, permanent: true },`,
        ),
      ].join("\n");

    case "nginx":
      return [
        "# nginx — place inside the relevant server { } block:",
        ...pairs.map((p) => `location = ${p.from} { return 301 ${p.to}; }`),
      ].join("\n");

    case "apache":
      return [
        "# .htaccess (mod_alias)",
        ...pairs.map((p) => `Redirect 301 ${p.from} ${p.to}`),
      ].join("\n");

    case "netlify":
      return [
        "# _redirects",
        ...pairs.map((p) => `${p.from}  ${p.to}  301`),
      ].join("\n");

    case "csv":
      return ["from,to,status", ...pairs.map((p) => `${csv(p.from)},${csv(p.to)},301`)].join("\n");

    default:
      return "";
  }
}

function csv(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}
