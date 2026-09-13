import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "../../lib/db";

// pg needs Node's TCP/net APIs, not Edge.
export const runtime = "nodejs";

// A cached readiness result is worse than none: it's the same "pod says
// Ready, database says otherwise" gap this route exists to close.
export const dynamic = "force-dynamic";

// Readiness: one SELECT 1, same reasoning as api/src/routes/readyz.ts. The
// chart's readinessProbe hits this so a pod with a mis-wired DB credential
// (wrong ConfigMap key, unsealed secret, a $(VAR) typo) is pulled from
// rotation instead of serving 500s to every tracking-page visitor - without
// the livenessProbe (still on /healthz) restarting the pod over a DB outage
// it can't fix by restarting.
export async function GET() {
  try {
    await getDb().execute(sql`select 1`);
    return NextResponse.json({ status: "ok" }, { status: 200 });
  } catch (err) {
    // Generic body, real detail only in the log: a stack trace or
    // connection string in the response is exactly the kind of leak this
    // probe shouldn't be the one to introduce. Structured JSON to stderr,
    // not console.error (docs/conventions.md -> Code style) - same shape
    // as db/src/logger.ts, which this route can't import (it's internal
    // to @frontdesk/db, not part of its public surface).
    process.stderr.write(
      JSON.stringify({
        level: "error",
        msg: "readyz: database check failed",
        time: new Date().toISOString(),
        err: err instanceof Error ? err.message : String(err),
      }) + "\n",
    );
    return NextResponse.json({ status: "not ready" }, { status: 503 });
  }
}
