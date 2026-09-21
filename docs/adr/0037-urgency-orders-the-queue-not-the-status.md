# ADR-0037: urgency orders the staff queue; it does not change request status

Status: decided 2026-09-21 (#153). Amends nothing; records why the option the issue recommended was not taken.

## Context

Issue #153 asked whether a request the classifier marks `urgency: high` should be routed to `needs_human` before "a draft is published", instead of `drafted`. It was filed while investigating #152 with a real submission ("Bad toothache since this morning. What do I do? Come in tomorrow?") and recommended the status change, on the grounds that a patient asking whether to be seen today should not get an auto-published answer no human has seen.

That premise is wrong, and it is worth writing down why, because it will be raised again.

**Nothing is published on `drafted`.** The requester's tracking page (`web/src/lib/tracking.ts`) renders reply text in exactly one case: `status = 'approved'`, which only a staff action sets (`web/src/lib/staffActions.ts`, F12). `drafted` and `needs_human` both collapse to the same public state - badge "In review", copy "Someone is working on your request now. Their reply will appear on this page once it has been approved." A high-urgency request was never at risk of being answered without a human. Changing its status to `needs_human` would alter one thing observable by anyone: the color of a badge in the staff queue.

What the toothache submission actually exposed was different and real:

1. **The staff queue was age-ordered** (`ORDER BY created_at DESC`, F10). A high-urgency clinical question submitted at 8:05 sat below an insurance question submitted at 8:07. For a receptionist scanning the queue, that is the failure - not the status label.
2. **`needs_human` already means something specific**: the pipeline could not produce a draft (empty retrieval, or a citation that failed validation after retry - `worker/frontdesk_worker/pipeline.py`). A high-urgency request usually *does* get a good draft; the issue is that it should be read before the one-click "Approve as drafted" button is pressed. Overloading `needs_human` to also mean "read carefully" would make the badge say less, not more.
3. **The seed row lied.** `seed-bsd-toothache-emergency` in `db/src/seed.ts` was hand-typed as `needs_human` + `high`; the live pipeline produces `drafted` for that input. A visitor comparing the demo queue to a real submission would see the product contradict its own seed data.

## Decision

1. **Status is untouched.** The pipeline's two terminal states keep their meaning: `drafted` = a citation-validated draft exists; `needs_human` = it does not. Urgency never influences status. Any future "route to human" policy should be a *new* signal, not a reuse of `needs_human`.

2. **The staff queue sorts by triage rank, then age.** `web/src/lib/staffQueue.ts` orders by `case when status in ('approved','rejected') then 2 when status = 'needs_human' then 0 when urgency = 'high' then 1 else 2 end`, then `created_at desc`. Rows the pipeline could not handle come first; open high-urgency rows come next; everything else, including resolved high-urgency rows, follows in age order. No configuration: this is the order every org's staff should see, and an org-level toggle would be a knob nobody would find.

3. **The request detail page carries a high-urgency callout while the request is open.** Above the original message, before the action forms: "High urgency - read before approving," with one sentence telling staff to check the draft against the message and to edit or handle directly if the right answer is "call us now." Hidden once resolved.

4. **The seed row is corrected to `drafted`**, with a comment pointing here so it is not "fixed" back.

5. **Not done: an org-configured `humanReviewLanes` list** (the issue's option 1). It would add a settings key, a schema refinement, a pipeline branch, a migration backfill, and a status semantics change, to produce an outcome (a human reads the request before approving) the sort order and callout already produce with no new state. If a real org asks for a lane whose requests *must never* be approved as drafted - a hard block, not a nudge - that is the point to add it, as a distinct status or a distinct action-time guard, with that org's requirement as the evidence.

## Consequences

- The queue query no longer walks `requests_org_id_created_at_idx` straight into `LIMIT 50`; Postgres filters by `org_id` through the index, then top-N sorts the org's rows in memory. At the table's current size that is not measurable. If it ever is, the fix is an expression index on `(org_id, <rank>, created_at desc)`, recorded with the EXPLAIN that motivated it, same as the original index was.
- `web/src/lib/staffQueue.test.ts` asserts the relative order of a `needs_human`, an open high-urgency, a resolved high-urgency, and a normal row, inserted oldest-first so an age-only sort returns them in exactly the reverse order. Verified by mutation: reverting the `orderBy` fails that test alone.
- REQUIREMENTS F10 ("Queue view per org: lane, urgency, age, status") is satisfied more literally than before - urgency now participates in the *order*, not just the columns. No requirement text changes.
- The eval gate (ADR-0036) is unaffected: it scores classification and retrieval, and `urgency_accuracy` remains reported-not-gated. Nothing here changes what the model is asked or what it returns.
