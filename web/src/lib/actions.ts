"use server";

import { redirect } from "next/navigation";
import { loadApiOrigin } from "./env";
import type { SubmitState } from "./submitState";

// Every runtime export of a "use server" file must be an async function -
// Next builds a callable-action-endpoint table from this module's exports
// literally, so a non-function export (SubmitState/INITIAL_SUBMIT_STATE
// used to live here) makes the whole module throw at evaluation time. See
// web/src/lib/submitState.ts's comment and
// web/src/app/r/[slug]/submit.e2e.test.ts for the regression this
// guards against - only `type`-only imports of SubmitState belong here.

function stringField(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value.trim() : "";
}

/**
 * F1's public form, submitted server-side (ADR-0021 "one enqueue
 * implementation" - this calls api/'s own intake endpoint rather than
 * inserting into `requests` directly). `slug` is bound by the caller
 * (`PublicForm`'s `submitPublicRequest.bind(null, slug)`) so this can be
 * shared by both `/r/[slug]` and the landing page's embedded demo form.
 *
 * Runs inside the web pod (a Next.js Server Action, not the visitor's
 * browser) - the pod-to-pod call ADR-0021 requires, and exactly the call
 * api-networkpolicy.yaml's second `from` entry exists to allow.
 */
export async function submitPublicRequest(
  slug: string,
  _prevState: SubmitState,
  formData: FormData,
): Promise<SubmitState> {
  const subject = stringField(formData, "subject");
  const body = stringField(formData, "body");
  const requesterName = stringField(formData, "requesterName");
  const requesterEmail = stringField(formData, "requesterEmail");
  const turnstileToken = stringField(formData, "cf-turnstile-response");

  if (!subject || !body) {
    return { status: "error", message: "Subject and message are both required." };
  }
  if (!turnstileToken) {
    // The widget hasn't finished its challenge yet (or JS is blocked) -
    // api/'s own schema would reject this as a missing field too, but
    // catching it here avoids a round trip for the single most likely
    // way a real visitor hits this path.
    return { status: "error", message: "Please complete the verification and try again." };
  }

  const payload: Record<string, string> = {
    subject,
    body,
    "cf-turnstile-response": turnstileToken,
  };
  if (requesterName) payload.requesterName = requesterName;
  if (requesterEmail) payload.requesterEmail = requesterEmail;

  const apiOrigin = loadApiOrigin();

  let res: Response;
  try {
    res = await fetch(`${apiOrigin}/api/v1/orgs/${encodeURIComponent(slug)}/requests`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    // Network failure reaching api/ (e.g. the NetworkPolicy or Service
    // is mis-wired) - a generic message here, not the underlying error:
    // this is a public form, and the failure detail is nothing a visitor
    // needs or should see.
    return { status: "error", message: "Something went wrong. Please try again." };
  }

  if (!res.ok) {
    if (res.status === 403) {
      return { status: "error", message: "Verification failed. Please try again." };
    }
    if (res.status === 404) {
      return { status: "error", message: "This organization isn't accepting requests right now." };
    }
    return { status: "error", message: "Something went wrong. Please try again." };
  }

  const { trackingUrl } = (await res.json()) as { trackingUrl: string };
  // Outside the try/catch above on purpose: redirect() throws a Next
  // control-flow signal, not a real error - catching it as one would
  // swallow the redirect instead of navigating.
  redirect(trackingUrl);
}
