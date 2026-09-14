import { forOrg, requestStatus, requests, resolveTracking, type Db } from "@frontdesk/db";
import { and, eq } from "drizzle-orm";

type RequestStatus = (typeof requestStatus.enumValues)[number];

export type NonApprovedStatus = Exclude<RequestStatus, "approved">;

export type TrackingView =
  | { kind: "not_found" }
  | { kind: "status"; status: NonApprovedStatus }
  // F12: reply_text is the snapshot written at approve time - this is the
  // ONLY variant that ever carries reply text. Every other status renders
  // from the `status` variant above, which has no body field to leak.
  | { kind: "approved"; replyText: string };

/**
 * F2/F12 tracking page data. `resolveTracking()` is the sole unscoped read
 * (a SECURITY DEFINER function that maps a public token to an org id and
 * request id without exposing any row data); everything after it runs
 * through `forOrg()`, and the select still filters by org_id explicitly
 * (ADR-0018 "belt and braces") on top of RLS.
 *
 * An unknown token and a malformed one produce the same `not_found` result
 * for the same reason: `resolveTracking`/the scoped select just find no
 * row either way, there is no separate "malformed" code path to leak
 * through.
 */
export async function getTrackingView(db: Db, token: string): Promise<TrackingView> {
  const resolution = await resolveTracking(db, token);
  if (!resolution) return { kind: "not_found" };

  const row = await forOrg(db, resolution.orgId, async (tx, orgId) => {
    const rows = await tx
      .select({ status: requests.status, replyText: requests.replyText })
      .from(requests)
      .where(and(eq(requests.orgId, orgId), eq(requests.id, resolution.requestId)));
    return rows[0];
  });

  // resolveTracking just found this token; nothing in this schema deletes
  // a requests row, so this is unreachable in practice. Still not assumed:
  // treat it the same as an unknown token rather than throwing.
  if (!row) return { kind: "not_found" };

  if (row.status === "approved") {
    return { kind: "approved", replyText: row.replyText ?? "" };
  }
  return { kind: "status", status: row.status };
}

// Shared by /t/[token] and the landing page's demo queue (F16) - both
// render the same non-approved statuses and should say the same thing.
export function statusLabel(status: NonApprovedStatus): string {
  switch (status) {
    case "received":
      return "Received";
    case "triaging":
    case "drafted":
    case "needs_human":
      return "In review";
    case "rejected":
      return "Reviewed";
  }
}
