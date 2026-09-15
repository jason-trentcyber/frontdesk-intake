import { PublicForm } from "../components/PublicForm";
import { getDb } from "../lib/db";
import { getDemoOrg, getDemoQueue } from "../lib/demoQueue";
import { loadTurnstileSiteKey } from "../lib/env";
import { statusLabel } from "../lib/tracking";

// pg needs Node's TCP/net APIs; Next's default runtime for a dynamic
// route can be Edge, which has neither (same reasoning as /t/[token]
// and /r/[slug] - this route uses getDb() too).
export const runtime = "nodejs";

// F16's queue is live - the purge CronJob (#28) also means it's often
// empty by design (deleted after 24h), not a stale cached snapshot of
// whatever it looked like at build time.
export const dynamic = "force-dynamic";

export default async function HomePage() {
  const db = getDb();
  const demoOrg = await getDemoOrg(db);
  const queue = demoOrg ? await getDemoQueue(db, demoOrg.id) : [];
  const turnstileSiteKey = loadTurnstileSiteKey();

  return (
    <main>
      <h1>frontdesk</h1>
      <p className="mt-2 max-w-2xl">
        An AI-assisted request desk for small businesses: a visitor submits a request, an LLM
        triages it and drafts a cited reply from the business&apos;s own documents, and staff
        approve, edit, or reject before anything goes out.
      </p>
      <nav aria-label="Project links" className="mt-4 text-sm text-slate-600">
        <a href="https://github.com/jason-trentcyber/frontdesk-intake">Repo</a>
        {" · "}
        <a href="https://github.com/users/jason-trentcyber/projects/1">Board</a>
        {" · "}
        <a href="https://github.com/jason-trentcyber/frontdesk-intake/blob/main/REQUIREMENTS.md">
          Docs
        </a>
      </nav>

      <div className="mt-10 grid grid-cols-1 gap-8 md:grid-cols-2">
        <section aria-labelledby="demo-form-heading">
          <h2 id="demo-form-heading">Try it - {demoOrg?.name ?? "the demo"}</h2>
          {demoOrg ? (
            <div className="card mt-3">
              <PublicForm
                slug={demoOrg.slug}
                orgName={demoOrg.name}
                turnstileSiteKey={turnstileSiteKey}
              />
            </div>
          ) : (
            <p className="mt-3">The demo isn&apos;t configured right now.</p>
          )}
        </section>

        <section aria-labelledby="demo-queue-heading">
          <h2 id="demo-queue-heading">Live queue</h2>
          {queue.length === 0 ? (
            // Not an edge case: F17 purges demo submissions after 24h,
            // so this is the state every morning until someone submits.
            <p className="mt-3">
              No requests in the last 24 hours - they&apos;re purged on a schedule (F17). Submit the
              form to see one appear here.
            </p>
          ) : (
            <ul className="mt-3 space-y-3">
              {queue.map((item) => (
                <li key={item.id} className="card p-4">
                  <p className="font-medium text-slate-900">{item.subject}</p>
                  {item.kind === "approved" ? (
                    <p className="mt-1 text-sm">{item.replyText}</p>
                  ) : (
                    <p className="mt-1 text-sm text-slate-600">
                      Status: {statusLabel(item.status)}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}
