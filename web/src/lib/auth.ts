import { authAccounts, authSessions, authUsers, authVerificationTokens } from "@frontdesk/db";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import NextAuth from "next-auth";
import GitHub from "next-auth/providers/github";
import Google from "next-auth/providers/google";
import { getDb } from "./db";

// ADR-0031. DrizzleAdapter is instantiated against the same pooled Db
// singleton every other request-time query uses (web/src/lib/db.ts,
// max: 5) - not a second pool. The table objects passed here are
// db/src/schema/auth.ts's auth.* tables (a dedicated Postgres schema,
// no org_id, no RLS - Auth.js identities and sessions are not tenant
// data).
//
// session: { strategy: "database" }, not the JWT default: a session's
// validity is one auth.sessions row, so removing someone's org_members
// row (the actual authorization decision - see requireMembership() in
// ./auth-guard) takes effect on their very next request. Auth.js's own
// providers auto-read AUTH_GOOGLE_ID/AUTH_GOOGLE_SECRET/AUTH_GITHUB_ID/
// AUTH_GITHUB_SECRET and AUTH_SECRET from the environment - no explicit
// config needed for any of them (Next.js's own documented convention).
//
// getAuth() builds NextAuth() lazily, on first call, not as this
// module's top-level statement: `next build`'s "Collecting page data"
// phase imports every route module (including /app's layout and page)
// to read their static exports, and getDb() - unlike a bare `new
// pg.Pool()` - throws immediately if DATABASE_URL/DATABASE_APP_URL
// isn't set (web/src/lib/env.ts's fail-loudly convention). Production
// deliberately never sets a database URL at build time (only at pod
// runtime, via the chart), so a top-level `NextAuth({ adapter:
// DrizzleAdapter(getDb(), ...) })` call broke `next build` itself, not
// just a request path - verified locally via `docker build -f
// web/Dockerfile .`, which reproduces the build exactly as CI runs it.
// Every caller goes through this function rather than a re-exported
// `auth`/`handlers` binding, so nothing can accidentally reintroduce a
// top-level call.
let cached: ReturnType<typeof NextAuth> | undefined;

export function getAuth(): ReturnType<typeof NextAuth> {
  if (!cached) {
    cached = NextAuth({
      adapter: DrizzleAdapter(getDb(), {
        usersTable: authUsers,
        accountsTable: authAccounts,
        sessionsTable: authSessions,
        verificationTokensTable: authVerificationTokens,
      }),
      session: { strategy: "database" },
      providers: [Google, GitHub],
      callbacks: {
        // Thin on purpose (ADR-0031): email only. org_id/role are NEVER
        // added here - resolveMembership() re-derives them from
        // org_members on every request that needs them
        // (requireMembership() in ./auth-guard), so an allow-list
        // removal can never be masked by a stale cached value here.
        session({ session, user }) {
          return {
            ...session,
            user: { email: user.email },
          };
        },
      },
    });
  }
  return cached;
}
