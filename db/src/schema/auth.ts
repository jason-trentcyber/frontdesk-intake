import { integer, pgSchema, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";

// ADR-0031: Auth.js's own tables (identities, OAuth links, sessions,
// verification tokens) live in a dedicated `auth` Postgres schema, not
// `public` alongside tenant tables. No org_id, no RLS, no pgPolicy on
// anything here - a Google/GitHub identity and its session are not
// scoped to an org. org_members (public, RLS'd) is the join that gives
// an identity an org, by email; nothing in this file depends on it.
// db/src/coverage.test.ts asserts the converse of this file's existence:
// every table here has no org_id, and every tenant table outside `auth`
// still has one.
export const authSchema = pgSchema("auth");

// Property names on every table below (id, email, emailVerified,
// sessionToken, userId, providerAccountId, refresh_token, access_token,
// expires_at, token_type, id_token, session_state, identifier, token,
// expires) match exactly what @auth/drizzle-adapter's PostgresDrizzleAdapter
// reads/writes by property access (verified against its source,
// @auth/drizzle-adapter/src/lib/pg.ts) - only the underlying column NAME
// strings are chosen to match this repo's snake_case convention
// (ADR-0018), which the adapter never inspects.

export const authUsers = authSchema.table("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name"),
  // Auth.js's own getUserByEmail does an exact match, not a
  // case-insensitive one - unlike org_members.email (citext,
  // ADR-0018), so this stays plain text. resolveMembership() still
  // matches this value against org_members case-insensitively on the
  // org_members side of that comparison.
  email: text("email").notNull().unique(),
  emailVerified: timestamp("email_verified", { withTimezone: true }),
  image: text("image"),
});

export const authAccounts = authSchema.table(
  "accounts",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    provider: text("provider").notNull(),
    providerAccountId: text("provider_account_id").notNull(),
    refresh_token: text("refresh_token"),
    access_token: text("access_token"),
    expires_at: integer("expires_at"),
    token_type: text("token_type"),
    scope: text("scope"),
    id_token: text("id_token"),
    session_state: text("session_state"),
  },
  (t) => [primaryKey({ columns: [t.provider, t.providerAccountId] })],
);

export const authSessions = authSchema.table("sessions", {
  // Database session strategy (ADR-0031): this row's existence IS the
  // session. Deleting it (an org_members removal does not delete it
  // directly, but the membership check downstream of it re-resolves and
  // fails closed - see web/src/lib/auth-guard.ts) is how revocation
  // takes effect without a sign-out.
  sessionToken: text("session_token").primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => authUsers.id, { onDelete: "cascade" }),
  expires: timestamp("expires", { withTimezone: true }).notNull(),
});

export const authVerificationTokens = authSchema.table(
  "verification_tokens",
  {
    identifier: text("identifier").notNull(),
    token: text("token").notNull(),
    expires: timestamp("expires", { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.identifier, t.token] })],
);
