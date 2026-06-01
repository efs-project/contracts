import { Suspense } from "react";
import ListDetailClient from "./ListDetailClient";

/**
 * Server component wrapper — required so Next.js static export allows
 * `generateStaticParams` alongside the `"use client"` detail component.
 * Pattern mirrors `app/explorer/[[...path]]/page.tsx` (ADR-0040).
 *
 * The real listUID is read at runtime from `usePathname()` inside
 * ListDetailClient; this dummy entry lets the static export emit the
 * route shell at build time.
 */
export function generateStaticParams() {
  return [{ listUID: "0x0000000000000000000000000000000000000000000000000000000000000000" }];
}

export default function ListDetailPage() {
  return (
    <Suspense fallback={null}>
      <ListDetailClient />
    </Suspense>
  );
}
