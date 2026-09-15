import { requestStatus } from "@frontdesk/db";
import { Badge } from "./Badge";

type RequestStatus = (typeof requestStatus.enumValues)[number];

// F10's full lane/urgency/age/status filters and F11/F12's request detail
// and actions are 26b's scope - /app's queue (web/src/app/app/page.tsx)
// stays a minimal, styled read only, per ADR-0031/26a. Status badge colors
// are a small closed set mirroring db/src/schema/enums.ts's requestStatus
// values. Kept as its own module (not inlined in page.tsx) so it can be
// unit-tested without importing page.tsx's auth-guard chain (next-auth's
// ESM resolution doesn't work under plain vitest - see StatusBadge.test.tsx).
// Keyed by RequestStatus, not a bare string, so adding/renaming/removing a
// status in the enum is a compile error here, not a silent fallback to the
// default badge style at runtime.
const STATUS_STYLES: Record<RequestStatus, string> = {
  received: "bg-slate-100 text-slate-800",
  triaging: "bg-blue-100 text-blue-800",
  drafted: "bg-blue-100 text-blue-800",
  needs_human: "bg-amber-100 text-amber-800",
  approved: "bg-green-100 text-green-800",
  rejected: "bg-red-100 text-red-800",
};

export function StatusBadge({ status }: { status: string }) {
  const style = STATUS_STYLES[status as RequestStatus] ?? "bg-slate-100 text-slate-800";
  return <Badge className={style}>{status}</Badge>;
}
