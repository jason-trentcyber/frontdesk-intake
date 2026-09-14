import { orgs } from "@frontdesk/db";
import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { PublicForm } from "../../../components/PublicForm";
import { getDb } from "../../../lib/db";
import { loadTurnstileSiteKey } from "../../../lib/env";

// pg needs Node's TCP/net APIs; Next's default runtime for a dynamic
// route can be Edge, which has neither (same reasoning as /t/[token]).
export const runtime = "nodejs";

// An org's existence/name could change; more importantly, there is no
// reason for this page to ever be a cached, stale copy of a live form.
export const dynamic = "force-dynamic";

export default async function PublicFormPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const db = getDb();

  // orgs carries no org_id/RLS (not a tenant table); ANY org's slug is a
  // valid target here, not just the demo org - F1's public form is per
  // org, and api/'s own intake route does the identical unscoped lookup
  // by slug for the same reason.
  const [org] = await db.select({ id: orgs.id, slug: orgs.slug, name: orgs.name }).from(orgs).where(eq(orgs.slug, slug));
  if (!org) {
    notFound();
  }

  const turnstileSiteKey = loadTurnstileSiteKey();

  return (
    <main>
      <h1>Contact {org.name}</h1>
      <PublicForm slug={org.slug} orgName={org.name} turnstileSiteKey={turnstileSiteKey} />
    </main>
  );
}
