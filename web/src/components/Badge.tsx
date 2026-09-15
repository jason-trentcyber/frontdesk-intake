import type { ReactNode } from "react";

// Shared pill markup for /app's per-status badges (web/src/app/app/page.tsx)
// and /t/[token]'s status badge (web/src/app/t/[token]/page.tsx) - only the
// markup/shape is shared, not the color mapping. The two pages show
// different audiences different granularity on purpose: /app is staff-only
// and shows the real status (six colors, one per db/src/schema/enums.ts
// value); /t/[token] is public and deliberately collapses everything
// non-approved into one neutral badge (statusLabel() in lib/tracking.ts
// does the same collapsing for the text). Forcing both to read from one
// color lookup would blur that intentional difference, not just deduplicate
// markup.
export function Badge({ className, children }: { className: string; children: ReactNode }) {
  return (
    <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${className}`}>
      {children}
    </span>
  );
}
