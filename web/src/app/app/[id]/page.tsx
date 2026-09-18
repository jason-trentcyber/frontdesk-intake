import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Badge } from "../../../components/Badge";
import { StatusBadge } from "../../../components/StatusBadge";
import { requireSessionOrRedirect } from "../../../lib/auth-guard";
import { getDb } from "../../../lib/db";
import { getRequestDetail } from "../../../lib/requestDetail";
import {
  approveRequestAction,
  editApproveRequestAction,
  rejectRequestAction,
} from "../../../lib/staffActions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// A staff-only surface has no reason to be indexed.
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

const ACTION_KIND_LABEL: Record<string, string> = {
  approve: "Approved",
  edit: "Edited & approved",
  reject: "Rejected",
};

const RESOLVED_STATUSES = new Set(["approved", "rejected"]);

// requests.id is a Postgres uuid column - a malformed [id] segment (a
// typo'd link, a crawler probing paths) would otherwise reach
// getRequestDetail()/forOrg() and surface as a raw "invalid input syntax
// for uuid" error from the database instead of a clean, expected 404.
// Not a security boundary (the query is parameterized via Drizzle either
// way, so this is not an injection concern) - purely a cleaner failure
// mode for an input that was never going to match a row.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function RequestDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const membership = await requireSessionOrRedirect();
  if (!membership) {
    return null;
  }

  const { id } = await params;
  if (!UUID_RE.test(id)) {
    notFound();
  }

  const view = await getRequestDetail(getDb(), membership.orgId, id);
  if (view.kind === "not_found") {
    notFound();
  }

  const { request, latestDraft, citations, actionHistory } = view;
  const isResolved = RESOLVED_STATUSES.has(request.status);

  return (
    <main>
      <div className="flex items-baseline justify-between gap-4">
        <h1 className="truncate">{request.subject}</h1>
        <StatusBadge status={request.status} />
      </div>
      <p className="mt-1 text-sm text-slate-600">
        Received {request.createdAt.toISOString()}
        {request.requesterName ? ` from ${request.requesterName}` : ""}
        {request.requesterEmail ? ` (${request.requesterEmail})` : ""}
      </p>

      {/* F11: original text. */}
      <section aria-labelledby="original-heading" className="card mt-6">
        <h2 id="original-heading" className="text-base">
          Original message
        </h2>
        <p className="mt-3 whitespace-pre-wrap">{request.body}</p>
      </section>

      {/* F11: classification. category/urgency/lane are free text or
          null until the triage pipeline (F4) sets them - never assumed
          present. */}
      <section aria-labelledby="classification-heading" className="card mt-4">
        <h2 id="classification-heading" className="text-base">
          Classification
        </h2>
        <dl className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-slate-500">Category</dt>
            <dd className="text-slate-900">{request.category ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-slate-500">Urgency</dt>
            <dd className="text-slate-900">{request.urgency ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-slate-500">Lane</dt>
            <dd className="text-slate-900">{request.lane ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-slate-500">Confidence</dt>
            <dd className="text-slate-900">{latestDraft ? latestDraft.confidence : "—"}</dd>
          </div>
        </dl>
        {request.summary && <p className="mt-3 text-sm text-slate-700">{request.summary}</p>}
      </section>

      {/* F11: draft + F11 "citations rendered as expandable source
          snippets". latestDraft is the highest drafts.version for this
          request - there is no is_winning column (26b decision #1, PR
          body). */}
      <section aria-labelledby="draft-heading" className="card mt-4">
        <h2 id="draft-heading" className="text-base">
          Draft reply{" "}
          {latestDraft && (
            <span className="text-sm font-normal text-slate-500">
              (version {latestDraft.version})
            </span>
          )}
        </h2>
        {latestDraft ? (
          <>
            <p className="mt-3 whitespace-pre-wrap">{latestDraft.body}</p>
            {citations.length > 0 && (
              <div className="mt-4 space-y-2">
                <p className="text-sm font-medium text-slate-700">Sources</p>
                {citations.map((c) => (
                  <details
                    key={c.chunkId}
                    className="rounded-md border border-slate-200 p-2 text-sm"
                  >
                    <summary className="cursor-pointer font-medium text-slate-700">
                      [c:{c.chunkId}]
                    </summary>
                    <p className="mt-2 text-slate-700">{c.text}</p>
                  </details>
                ))}
              </div>
            )}
          </>
        ) : (
          <p className="mt-3 text-slate-500">No draft yet.</p>
        )}
      </section>

      {/* F12: approve / edit-then-approve / reject-with-reason. Hidden
          once the request is resolved - re-approving or re-rejecting an
          already-decided request isn't a workflow F12 asks for, and the
          action history below already shows what happened. */}
      {!isResolved && (
        <section aria-labelledby="actions-heading" className="card mt-4">
          <h2 id="actions-heading" className="text-base">
            Actions
          </h2>
          <div className="mt-4 grid grid-cols-1 gap-6 lg:grid-cols-2">
            <div>
              <h3 className="text-sm font-medium text-slate-700">Edit &amp; approve</h3>
              <form
                action={editApproveRequestAction.bind(null, request.id)}
                className="mt-2 space-y-3"
              >
                <div>
                  <label htmlFor="edit-body">Reply text</label>
                  <textarea
                    id="edit-body"
                    name="body"
                    defaultValue={latestDraft?.body ?? ""}
                    required
                    rows={6}
                  />
                </div>
                <button
                  type="submit"
                  className="bg-brand hover:bg-brand-hover px-4 py-2 text-sm text-white transition-colors"
                >
                  Save &amp; approve
                </button>
              </form>

              {latestDraft && (
                <form action={approveRequestAction.bind(null, request.id)} className="mt-3">
                  <button
                    type="submit"
                    className="border border-slate-300 px-4 py-2 text-sm text-slate-800"
                  >
                    Approve as drafted
                  </button>
                </form>
              )}
            </div>

            <div>
              <h3 className="text-sm font-medium text-slate-700">Reject</h3>
              <form action={rejectRequestAction.bind(null, request.id)} className="mt-2 space-y-3">
                <div>
                  <label htmlFor="reject-reason">Reason</label>
                  <textarea id="reject-reason" name="reason" required rows={3} />
                </div>
                <button
                  type="submit"
                  className="bg-red-700 px-4 py-2 text-sm text-white transition-colors hover:bg-red-800"
                >
                  Reject
                </button>
              </form>
            </div>
          </div>
        </section>
      )}

      {/* F12: "every action is audit-logged (who, when, before/after)" -
          the full history, not just the latest action. */}
      {actionHistory.length > 0 && (
        <section aria-labelledby="history-heading" className="card mt-4">
          <h2 id="history-heading" className="text-base">
            History
          </h2>
          <ul className="mt-3 space-y-3 text-sm">
            {actionHistory.map((action) => (
              <li
                key={action.id}
                className="border-b border-slate-100 pb-3 last:border-0 last:pb-0"
              >
                <div className="flex items-center gap-2">
                  <Badge className="bg-slate-100 text-slate-800">
                    {ACTION_KIND_LABEL[action.kind] ?? action.kind}
                  </Badge>
                  <span className="text-slate-500">
                    {action.actorEmail} · {action.createdAt.toISOString()}
                  </span>
                </div>
                {action.reason && <p className="mt-1 text-slate-700">Reason: {action.reason}</p>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
