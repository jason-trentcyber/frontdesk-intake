import { getDb } from "../../lib/db";
import { requireSessionOrRedirect } from "../../lib/auth-guard";
import { getStaffQueue } from "../../lib/staffQueue";

// F10's full lane/urgency/age/status filters and F11/F12's request detail
// and actions are 26b's scope - this page stays a minimal, styled read
// only, per ADR-0031/26a. Status badge colors are a small closed set
// mirroring db/src/schema/enums.ts's requestStatus values; not extracted
// to a shared module yet since this is the only consumer until 26b.
const STATUS_STYLES: Record<string, string> = {
  received: "bg-slate-100 text-slate-800",
  triaging: "bg-blue-100 text-blue-800",
  drafted: "bg-blue-100 text-blue-800",
  needs_human: "bg-amber-100 text-amber-800",
  approved: "bg-green-100 text-green-800",
  rejected: "bg-red-100 text-red-800",
};

function StatusBadge({ status }: { status: string }) {
  const style = STATUS_STYLES[status] ?? "bg-slate-100 text-slate-800";
  return (
    <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${style}`}>
      {status}
    </span>
  );
}

export default async function StaffQueuePage() {
  // Real membership check, called again (React's cache() dedupes this
  // against the layout's own call within the same request - see
  // web/src/lib/auth-guard.ts). AppLayout already renders the
  // "not a member" page in place of this component when membership is
  // null, so by the time this runs it is non-null - the `if` below is
  // belt and braces (ADR-0018's phrase for exactly this shape: trust
  // the enforced invariant, but don't silently assume it), not a path
  // this page expects to hit.
  const membership = await requireSessionOrRedirect();
  if (!membership) {
    return null;
  }

  const queue = await getStaffQueue(getDb(), membership.orgId);

  return (
    <main>
      <div className="flex items-baseline justify-between">
        <h1>Queue</h1>
        <a href="/api/auth/signout" className="text-sm text-slate-500">
          Sign out
        </a>
      </div>
      <p className="mt-1 text-sm text-slate-500">Signed in as {membership.email}</p>

      <div className="mt-6 overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-sm">
        {queue.length === 0 ? (
          <p className="p-6">No requests yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Subject</th>
                <th>Status</th>
                <th>Urgency</th>
                <th>Received</th>
              </tr>
            </thead>
            <tbody>
              {queue.map((item) => (
                <tr key={item.id}>
                  <td>{item.subject}</td>
                  <td>
                    <StatusBadge status={item.status} />
                  </td>
                  <td>{item.urgency ?? "—"}</td>
                  <td>{item.createdAt.toISOString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </main>
  );
}
