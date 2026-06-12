import "dotenv/config";
import { defineConfig } from "drizzle-kit";

// Only needed when you want versioned migrations (db:generate / db:push).
// Day-to-day local use does NOT require this — the schema is auto-created.
export default defineConfig({
  schema: "./src/schema.ts",
  out: "./drizzle",
  dialect: "turso",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "file:../../linkchecker.db",
    authToken: process.env.DATABASE_AUTH_TOKEN,
  },
});
