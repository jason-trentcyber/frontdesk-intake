import Link from "next/link";
import { StatusBadge } from "../../components/StatusBadge";
import { getDb } from "../../lib/db";
import { requireSessionOrRedirect } from "../../lib/auth-guard";
import {
  getStaffQueue,
  getStaffQueueFilterOptions,
  type RequestStatus,
} from "../../lib/staffQueue";

function toStringArray(value: string | string[] | undefined): string[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

export default async function StaffQueuePage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
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

  const params = await searchParams;
  // Filter values are validated against the org's own options below
  // (never trusted as-is) - an unrecognized status/lane in the query
  // string just filters to nothing, the same as any other empty result,
  // rather than reaching the database with an unvalidated value.
  const requestedStatus = toStringArray(params.status);
  const requestedLane = toStringArray(params.lane);

  const db = getDb();
  const filterOptions = await getStaffQueueFilterOptions(db, membership.orgId);
  const statusFilter = requestedStatus.filter((s): s is RequestStatus =>
    (filterOptions.statuses as string[]).includes(s),
  );
  const laneFilter = requestedLane.filter((l) => filterOptions.lanes.includes(l));

  const queue = await getStaffQueue(db, membership.orgId, {
    status: statusFilter.length > 0 ? statusFilter : undefined,
    lane: laneFilter.length > 0 ? laneFilter : undefined,
  });

  return (
    <main>
      <div className="flex items-baseline justify-between">
        <h1>Queue</h1>
        <a href="/api/auth/signout" className="text-sm text-slate-600">
          Sign out
        </a>
      </div>
      <p className="mt-1 text-sm text-slate-600">Signed in as {membership.email}</p>

      {/* F10: filter by lane and status. A plain GET form - no JS
          required, no client component, the filtered view is just a URL
          (?status=...&lane=...), bookmarkable and shareable like any
          other page. */}
      <form method="get" action="/app" className="card mt-6">
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
          <fieldset>
            <legend className="mb-2 text-sm font-medium text-slate-700">Status</legend>
            <div className="space-y-1">
              {filterOptions.statuses.map((status) => (
                <label key={status} className="mb-0 flex items-center gap-2 font-normal">
                  <input
                    type="checkbox"
                    name="status"
                    value={status}
                    defaultChecked={requestedStatus.includes(status)}
                    className="w-auto"
                  />
                  {status}
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset>
            <legend className="mb-2 text-sm font-medium text-slate-700">Lane</legend>
            {filterOptions.lanes.length === 0 ? (
              <p className="text-sm text-slate-500">No lanes configured.</p>
            ) : (
              <div className="space-y-1">
                {filterOptions.lanes.map((lane) => (
                  <label key={lane} className="mb-0 flex items-center gap-2 font-normal">
                    <input
                      type="checkbox"
                      name="lane"
                      value={lane}
                      defaultChecked={requestedLane.includes(lane)}
                      className="w-auto"
                    />
                    {lane}
                  </label>
                ))}
              </div>
            )}
          </fieldset>
        </div>

        <div className="mt-4 flex items-center gap-3">
          <button
            type="submit"
            className="bg-brand hover:bg-brand-hover px-4 py-2 text-sm text-white transition-colors"
          >
            Apply filters
          </button>
          {(requestedStatus.length > 0 || requestedLane.length > 0) && (
            <Link href="/app" className="text-sm text-slate-600">
              Clear filters
            </Link>
          )}
        </div>
      </form>

      <div className="card mt-6 overflow-x-auto p-0">
        {queue.length === 0 ? (
          <p className="p-6">No requests match this view.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Subject</th>
                <th>Status</th>
                <th>Urgency</th>
                <th>Lane</th>
                <th>Received</th>
              </tr>
            </thead>
            <tbody>
              {queue.map((item) => (
                <tr key={item.id}>
                  <td>
                    <Link href={`/app/${item.id}`}>{item.subject}</Link>
                  </td>
                  <td>
                    <StatusBadge status={item.status} />
                  </td>
                  <td>{item.urgency ?? "—"}</td>
                  <td>{item.lane ?? "—"}</td>
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
