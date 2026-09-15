import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Badge } from "../../../components/Badge";
import { getDb } from "../../../lib/db";
import { getTrackingView, statusDescription, statusLabel } from "../../../lib/tracking";

// pg needs Node's TCP/net APIs; Next's default runtime for a dynamic route
// can be Edge, which has neither.
export const runtime = "nodejs";

// This page's whole point is to show the *current* status - the instant a
// staff member approves a draft, a cached or statically-rendered copy of
// this route would keep showing "in review" (or worse, keep withholding a
// reply that now exists). App Router would otherwise be free to render
// this segment once and cache it, since a dynamic route param alone isn't
// a request-time signal. Force a fresh read on every request instead.
export const dynamic = "force-dynamic";

// A public, unauthenticated, per-request status page has no reason to be
// indexed or crawled.
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

// Module scope, not rebuilt per render: this is fixed copy, identical for
// every request and every org.
const NEXT_STEPS = [
  {
    title: "Triage.",
    detail: "Your message is sorted and matched against this business's own documents.",
  },
  {
    title: "Draft.",
    detail: "A reply is drafted from those documents, with the sources it drew on attached.",
  },
  {
    title: "Human review.",
    detail: "Someone at the business reads the draft and edits, approves, or rejects it.",
  },
  {
    title: "Reply.",
    detail: "Once approved, the reply appears on this page.",
  },
] as const;

export default async function TrackingPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const view = await getTrackingView(getDb(), token);

  if (view.kind === "not_found") {
    notFound();
  }

  if (view.kind === "approved") {
    return (
      <main>
        <h1>Your request</h1>
        <p className="mt-2">Here is the reply from the team.</p>
        <div className="card mt-4">
          <Badge className="bg-green-100 text-green-800">Approved</Badge>
          <p className="mt-4 whitespace-pre-wrap">{view.replyText}</p>
        </div>
        <p className="mt-6 text-sm text-slate-600">
          This reply was drafted from the business&apos;s own documents and approved by a person
          before it was sent. Keep this page&apos;s address if you want to read it again later - it
          is the only link to it.
        </p>
      </main>
    );
  }

  return (
    <main>
      <h1>Your request</h1>
      <p className="mt-2">Thanks - your message is with the team.</p>
      <div className="card mt-4">
        <Badge className="bg-slate-100 text-slate-800">{statusLabel(view.status)}</Badge>
        <p className="mt-4">{statusDescription(view.status)}</p>
      </div>

      {/* "rejected" is terminal - there is no next step to preview, and
          showing one would promise a reply that is not coming. */}
      {view.status !== "rejected" && (
        <section aria-labelledby="next-steps-heading" className="card mt-4">
          <h2 id="next-steps-heading" className="text-base">
            What happens next
          </h2>
          {/* The product's actual pipeline, in the visitor's words. Without
              this the page never reveals that a draft is written from the
              business's own documents and reviewed by a person - the two
              facts that make this different from a contact form, and both
              previously invisible from outside. No draft text, confidence
              or citation is exposed here; only the fixed shape of the
              process, which is the same for every request. */}
          <ol className="mt-4 space-y-3 text-sm">
            {NEXT_STEPS.map((step, i) => (
              <li key={step.title} className="flex gap-3">
                <span
                  aria-hidden="true"
                  className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-slate-100 text-xs leading-none font-medium text-slate-600"
                >
                  {i + 1}
                </span>
                <span>
                  <span className="font-medium text-slate-900">{step.title}</span>{" "}
                  <span className="text-slate-600">{step.detail}</span>
                </span>
              </li>
            ))}
          </ol>
        </section>
      )}

      <p className="mt-6 text-sm text-slate-600">
        Bookmark this page to check back - it is the only link to your request, and we will not
        email you a copy.
      </p>
    </main>
  );
}
