import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getDb } from "../../../lib/db";
import { getTrackingView, statusLabel } from "../../../lib/tracking";

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
        <div className="card mt-4">
          <span className="inline-flex rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-medium text-green-800">
            Approved
          </span>
          <p className="mt-4">{view.replyText}</p>
        </div>
      </main>
    );
  }

  return (
    <main>
      <h1>Your request</h1>
      <div className="card mt-4">
        <span className="inline-flex rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-800">
          {statusLabel(view.status)}
        </span>
      </div>
    </main>
  );
}
