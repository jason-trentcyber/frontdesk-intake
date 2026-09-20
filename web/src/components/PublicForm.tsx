"use client";

import Script from "next/script";
import { useActionState } from "react";
import { submitPublicRequest } from "../lib/actions";
import { INITIAL_SUBMIT_STATE } from "../lib/submitState";

export interface PublicFormProps {
  slug: string;
  orgName: string;
  turnstileSiteKey: string;
}

// F1: the public form at /r/<slug>, also embedded on the landing page for
// the demo org (F16, "side by side" with the live queue) - one component,
// two call sites, `slug` is the only thing that differs between them.
//
// Every input's `name` and the button's `type="submit"` are load-bearing
// (web/e2e/submit.spec.ts drives this form by selector) - unchanged by
// this pass, only classNames added.
export function PublicForm({ slug, orgName, turnstileSiteKey }: PublicFormProps) {
  const action = submitPublicRequest.bind(null, slug);
  const [state, formAction, pending] = useActionState(action, INITIAL_SUBMIT_STATE);
  const idPrefix = `public-form-${slug}`;

  return (
    <form action={formAction} aria-label={`Contact ${orgName}`} className="space-y-4">
      <div>
        <label htmlFor={`${idPrefix}-name`}>Name (optional)</label>
        <input id={`${idPrefix}-name`} name="requesterName" type="text" autoComplete="name" />
      </div>
      <div>
        <label htmlFor={`${idPrefix}-email`}>Email (optional)</label>
        <input id={`${idPrefix}-email`} name="requesterEmail" type="email" autoComplete="email" />
      </div>
      <div>
        <label htmlFor={`${idPrefix}-subject`}>Subject</label>
        <input id={`${idPrefix}-subject`} name="subject" type="text" required />
      </div>
      <div>
        <label htmlFor={`${idPrefix}-body`}>Message</label>
        <textarea id={`${idPrefix}-body`} name="body" required rows={4} />
      </div>
      {/* Implicit rendering: Cloudflare's script finds this div, renders
          the challenge, and injects a hidden `cf-turnstile-response`
          input into the enclosing <form> itself once it completes - no
          callback wiring needed, and it's the same field name api/'s
          bodySchema already expects. className="cf-turnstile" is how
          Cloudflare's script finds it - do not rename or wrap it.
          data-appearance="interaction-only" hides the widget unless the
          visitor actually has to click something; the default renders a
          Cloudflare-branded "Success!" panel mid-form for everyone. The
          token is still injected and api/ still verifies it, so this is
          purely cosmetic - not "invisible" mode, which is a widget-level
          setting requiring a Privacy Addendum reference we don't have. */}
      <Script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer />
      <div
        className="cf-turnstile"
        data-sitekey={turnstileSiteKey}
        data-appearance="interaction-only"
      />
      {state.status === "error" && (
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm font-medium text-red-700">
          {state.message}
        </p>
      )}
      <button
        type="submit"
        disabled={pending}
        className="bg-brand hover:bg-brand-hover rounded-md px-4 py-2 text-sm font-medium text-white transition-colors"
      >
        {pending ? "Sending…" : "Send"}
      </button>
    </form>
  );
}
