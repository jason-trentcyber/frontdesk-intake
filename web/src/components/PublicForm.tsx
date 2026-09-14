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
export function PublicForm({ slug, orgName, turnstileSiteKey }: PublicFormProps) {
  const action = submitPublicRequest.bind(null, slug);
  const [state, formAction, pending] = useActionState(action, INITIAL_SUBMIT_STATE);
  const idPrefix = `public-form-${slug}`;

  return (
    <form action={formAction} aria-label={`Contact ${orgName}`}>
      <div>
        <label htmlFor={`${idPrefix}-name`}>Name (optional)</label>
        <br />
        <input id={`${idPrefix}-name`} name="requesterName" type="text" autoComplete="name" />
      </div>
      <div>
        <label htmlFor={`${idPrefix}-email`}>Email (optional)</label>
        <br />
        <input id={`${idPrefix}-email`} name="requesterEmail" type="email" autoComplete="email" />
      </div>
      <div>
        <label htmlFor={`${idPrefix}-subject`}>Subject</label>
        <br />
        <input id={`${idPrefix}-subject`} name="subject" type="text" required />
      </div>
      <div>
        <label htmlFor={`${idPrefix}-body`}>Message</label>
        <br />
        <textarea id={`${idPrefix}-body`} name="body" required />
      </div>
      {/* Implicit rendering: Cloudflare's script finds this div, renders
          the challenge, and injects a hidden `cf-turnstile-response`
          input into the enclosing <form> itself once it completes - no
          callback wiring needed, and it's the same field name api/'s
          bodySchema already expects. */}
      <Script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer />
      <div className="cf-turnstile" data-sitekey={turnstileSiteKey} />
      {state.status === "error" && <p role="alert">{state.message}</p>}
      <button type="submit" disabled={pending}>
        {pending ? "Sending…" : "Send"}
      </button>
    </form>
  );
}
