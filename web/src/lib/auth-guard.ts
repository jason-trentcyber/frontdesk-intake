import { resolveMembership, type Membership } from "@frontdesk/db";
import { redirect } from "next/navigation";
import { cache } from "react";
import { getAuth } from "./auth";
import { getDb } from "./db";

export interface AuthenticatedMembership extends Membership {
  email: string;
}

// ADR-0031 §3: membership is re-resolved from org_members on every call
// via resolveMembership() (resolve_membership(), SECURITY DEFINER) -
// never read from a cached session/JWT value, so removing an
// org_members row takes effect on the very next request. React's
// cache() only memoizes *within* one request's render (server-only,
// request-scoped - it does not survive past the response), so
// /app/layout.tsx and the page it wraps share one real database round
// trip per request instead of two, without reintroducing any
// cross-request staleness. A Server Action is a separate request/
// invocation, so it is never served a memoized value from a page render
// that happened moments before - it always calls this fresh (ADR-0031
// §5: three *independent* checks, not one check reused).
const resolveAuthState = cache(async (): Promise<{ email: string | null; membership: Membership | null }> => {
  const session = await getAuth().auth();
  const email = session?.user?.email ?? null;
  if (!email) {
    return { email: null, membership: null };
  }
  const membership = await resolveMembership(getDb(), email);
  return { email, membership };
});

/**
 * For /app/layout.tsx and Server Components under /app/*. Redirects to
 * sign-in when there's no session at all (nothing to render past that
 * point); returns null - never throws, never crashes - when there is a
 * session but no org_members row, so the caller renders the "not a
 * member" page instead.
 */
export async function requireSessionOrRedirect(): Promise<AuthenticatedMembership | null> {
  const { email, membership } = await resolveAuthState();
  if (!email) {
    redirect("/api/auth/signin");
  }
  return membership ? { ...membership, email } : null;
}

/**
 * For every Server Action under /app/* (ADR-0031 §5) - called
 * independently at the top of each action, not assumed from the layout
 * having already checked. Throws rather than redirecting: a Server
 * Action is a POST endpoint invoked from already-rendered client code,
 * not a page navigation, so there is no page for a redirect to replace -
 * the thrown error surfaces as the action's rejected promise.
 */
export async function requireMembershipForAction(): Promise<AuthenticatedMembership> {
  const { email, membership } = await resolveAuthState();
  if (!email || !membership) {
    throw new Error("Not authenticated, or not a member of any organization.");
  }
  return { ...membership, email };
}
