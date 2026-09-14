import { getDb } from "../../lib/db";
import { requireSessionOrRedirect } from "../../lib/auth-guard";
import { getStaffQueue } from "../../lib/staffQueue";

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
      <h1>Queue</h1>
      <p>Signed in as {membership.email}</p>
      {queue.length === 0 ? (
        <p>No requests yet.</p>
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
                <td>{item.status}</td>
                <td>{item.urgency ?? "—"}</td>
                <td>{item.createdAt.toISOString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p>
        <a href="/api/auth/signout">Sign out</a>
      </p>
    </main>
  );
}
