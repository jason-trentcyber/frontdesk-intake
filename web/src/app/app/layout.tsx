import type { Metadata } from "next";
import type { ReactNode } from "react";
import { requireSessionOrRedirect } from "../../lib/auth-guard";

// pg needs Node's TCP/net APIs; Next's default runtime for a dynamic
// route can be Edge, which has neither (same reasoning as every other
// database-backed route in this app).
export const runtime = "nodejs";

// Membership can change (an allow-list removal, ADR-0031 §3) between one
// request and the next - a cached or statically-rendered copy of this
// layout would keep granting access a fresh check would now deny.
export const dynamic = "force-dynamic";

// A staff-only surface has no reason to be indexed.
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

// ADR-0031 §5/§7: the real check, at a real /app URL segment (not a
// route group - a route group leaves no trace in the URL, so "is this
// authenticated?" couldn't be answered from the path alone). Redirects
// to sign-in when there's no session; renders the "not a member" page
// in place of `children` when there is a session but no org_members row
// - never a crash, never an empty queue rendered as if it were real.
export default async function AppLayout({ children }: { children: ReactNode }) {
  const membership = await requireSessionOrRedirect();

  if (!membership) {
    return (
      <main>
        <h1>Not a member</h1>
        <p>Your account isn&apos;t a member of any organization here. Ask your organization&apos;s owner to add you.</p>
      </main>
    );
  }

  return <>{children}</>;
}
