import { NextResponse, type NextRequest } from "next/server";

// ADR-0031 §5: the cheap layer, deliberately doing as little as
// possible. Checks only whether a session cookie exists - no database
// call, no membership resolution, no import of ./src/lib/auth at all.
// The real authorization decision happens in /app/layout.tsx and inside
// every Server Action under /app/*, which re-run independently rather
// than trusting this file to have already decided anything: Next's own
// docs say proxy "can run outside of your application's main runtime",
// and CVE-2025-29927 was a real bypass of exactly this kind of
// single-checkpoint design (a crafted x-middleware-subrequest header
// skipped middleware entirely). Next 16's proxy.ts runs on the Node.js
// runtime by default (no `runtime` export here - it isn't available in
// a proxy file and setting it throws, per Next's proxy.js docs), which
// removes the reason Auth.js's "split config" pattern exists, but
// doesn't change the CVE-2025-29927 lesson: proxy is a routing
// convenience, not an authorization boundary, regardless of which
// runtime it happens to execute on.
const SESSION_COOKIE_NAMES = ["authjs.session-token", "__Secure-authjs.session-token"];

export function proxy(request: NextRequest): NextResponse {
  const hasSessionCookie = SESSION_COOKIE_NAMES.some((name) => request.cookies.has(name));
  if (hasSessionCookie) {
    return NextResponse.next();
  }

  const signInUrl = new URL("/api/auth/signin", request.url);
  signInUrl.searchParams.set("callbackUrl", request.nextUrl.pathname);
  return NextResponse.redirect(signInUrl);
}

export const config = {
  matcher: ["/app/:path*"],
};
