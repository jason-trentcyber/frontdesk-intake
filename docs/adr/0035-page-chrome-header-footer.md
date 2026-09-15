# ADR-0035: page chrome (header/footer) in `web/`'s root layout; amends ADR-0033

Status: decided 2026-09-15. Amends ADR-0033's Decision clause "Max-width container in the root layout": one `<div className="mx-auto max-w-4xl px-4 py-10 sm:px-6">` wrapping `{children}`. Everything else in ADR-0033 stands.

## Context

ADR-0033 describes the root layout exhaustively - one max-width container wrapping `{children}`, and nothing else. That is what PR #121 shipped, and it is correct as far as it goes: every page got a consistent reading width without repeating the class string per page.

Reviewing the result in a running browser rather than in the JSX showed what that description leaves out. With no header and no footer, every surface begins at the top-left of an empty `slate-50` field. Content styled well *inside* a frame that does not exist still reads as unfinished, and the shorter the page the worse it is: `/t/<token>` was roughly 170px of content in an 800px viewport, the rest empty.

This is not a defect in ADR-0033's reasoning; it is a surface that ADR never considered, because #121's brief was a styling stack and four page interiors. The gap only becomes visible once the interiors look finished.

## Decision

`web/src/app/layout.tsx` adds a `<header>` and `<footer>` around ADR-0033's container, and `body` becomes `flex min-h-screen flex-col` with `flex-1` on the content wrapper.

- **The container is unchanged.** Same `mx-auto max-w-4xl px-4 py-10 sm:px-6`, same position wrapping `{children}`. ADR-0033's clause is extended outward, not rewritten: nothing about reading width or side padding moves.
- **The flex column is what pins the footer.** `min-h-screen` on a flex-column body plus `flex-1` on the content wrapper puts the footer at the bottom of the viewport on short pages instead of floating mid-screen. That is the only reason `body`'s class list changes.
- **Header: a wordmark, no nav.** A brand square and the product name, linking to `/` via `next/link` (a client-side transition, not a document reload). No nav links and no "Sign in": `/app` is staff-only and would dead-end a visitor at an auth wall, and an empty nav bar reads worse than no nav at all. The revisit trigger is a second public destination worth linking to - not before.
- **Footer: one sentence, stating the human-approval step.** No public surface previously said anywhere that replies are drafted from the business's own documents and approved by a person. That is the product's actual claim, and it was invisible from outside.
- **No new tokens, dependencies, or animation.** `flex-1`, `leading-none`, `min-h-screen` are Tailwind's own scale, per ADR-0033's "no second bespoke token system" rule. ADR-0033's rejection of a component library is untouched.

## Rejected

- **Per-page headers.** Four copies of the same markup to keep in sync, and 26b's new surfaces would each have to remember it. The root layout is the one place that cannot be forgotten.
- **A logo image asset.** One more binary in the repo, one more request on the page, and a second file for dark mode or high-DPI. A text wordmark in a brand-colored square scales for free.
- **Chrome in `/app/layout.tsx` as well as the root.** The staff layout renders inside the root layout already; adding chrome there too would double it.

## Consequences

- Every surface - including `/app` and any 26b page - gets the header and footer automatically. A page wanting to suppress them would need a route group, which nothing currently does.
- The two pages ADR-0029's blocking Lighthouse gate audits (`/` and `/r/<slug>`) now render additional landmark elements. Re-ran that gate locally the way the CI job runs it (real `next build`, the standalone server, seeded Postgres, `--only-categories=accessibility`):

  ```
  accessibility score for /:                      1.0
  accessibility score for /r/bright-smile-dental:  1.0
  accessibility score for /t/<token>:              1.0
  ```

  Zero failing audits on all three. `/t/<token>` is audited here because it is the page this change affects most, and because ADR-0033's Consequences flagged extending the gate to it as an open question - this is evidence toward that decision, not a change to the gate, which remains exactly as ADR-0029 defines it.

- Contrast pairings are ones ADR-0033 already cleared (`slate-600`/`slate-900` on white, `slate-100`/`slate-600` for the step numerals on `/t/<token>`). No new pairing, and no `outline: none` anywhere.

## Acceptance

- `pnpm --filter @frontdesk/web build` succeeds; `make lint && make test` green (db 49, web 63, api 98, worker 153).
- Lighthouse accessibility >= 0.90 on `/` and `/r/<demo-slug>` - scored 1.0 on both, recorded above.
- Both Playwright specs stay green with **no selector changes**: this touches the root layout every authenticated page renders inside, so `cross-org-isolation.spec.ts` passing unmodified is the check that matters, not the form spec alone.
- The header wordmark performs a client-side transition, verified by marking `window` on `/t/<token>`, clicking the wordmark, and confirming the marker survives the navigation.
