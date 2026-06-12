"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** Refreshes the current route on an interval — used while a crawl is running. */
export function AutoRefresh({ intervalMs = 2500 }: { intervalMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    const id = setInterval(() => router.refresh(), intervalMs);
    return () => clearInterval(id);
  }, [router, intervalMs]);
  return null;
}
