# ADR-0033: Tailwind CSS v4 for `web/`'s styling; no component library

Status: decided 2026-09-15.

## Context

`web/` has never had a styling stack: no `.css` file anywhere, no Tailwind, no CSS-in-JS. `web/src/app/layout.tsx` was a bare `<html><body>{children}</body></html>`, and all four surfaces (`/`, `/r/[slug]`, `/t/[token]`, `/app`) rendered as unstyled browser-default HTML — real functionality (F1, F2, F16, #26) with no visual design layered on it at all. 26b adds request detail, filters, and action buttons on top of `/app`; those need a foundation to inherit from, not another round of ad hoc inline `style={{}}` props (which is what `/`'s two-column layout used until this PR — `display: flex` on a raw `style` attribute, no reusable convention behind it).

This is a new dependency, so per `AGENTS.md` ("Do not add dependencies... without an ADR reference in the PR") it needs one.

**The hard constraint that shaped every choice below**: ADR-0029's Lighthouse accessibility gate audits `/` and `/r/<demo-slug>`, blocking, threshold 0.90. Styling is exactly the kind of change that breaks it — insufficient color contrast, a removed focus outline, placeholder-as-label, a clickable `div` where a `button` belongs. Every color pairing below was chosen by computing its WCAG contrast ratio before writing a single component, not by eyeballing it and hoping Lighthouse agrees (see the PR body for the actual scores).

## Decision

**Tailwind CSS v4 (`tailwindcss` 4.3.3), via the official Next.js integration** (`@tailwindcss/postcss` 4.3.3 as a PostCSS plugin, `postcss` 8.5.28) — pinned exact versions, like every other dependency in this repo.

- `web/postcss.config.mjs` registers `@tailwindcss/postcss`. Next's Turbopack build (this repo's default, both `next dev` and `next build`) has built-in PostCSS support and picks this up with no `next.config.ts` change.
- `web/src/app/globals.css`: `@import "tailwindcss";`, one small `@theme` block, and a `@layer base` block giving `h1`/`h2`/`p`/`a`/`label`/`input`/`textarea`/`button`/`table`/`th`/`td` sensible defaults — this is the actual foundation 26b inherits. Imported once, in the root layout.
- **"Color tokens" and "spacing scale" means Tailwind's own built-in scales, not a second bespoke system layered on top.** Tailwind's whole value proposition *is* a token system (a fixed, named color and spacing scale instead of arbitrary values scattered through markup); inventing a parallel set of CSS custom properties duplicating `slate-600`/`p-4`/etc. under different names would be pure overhead for a four-page app. The one addition in `@theme` is `--color-brand`/`--color-brand-hover` (Tailwind's own `indigo-600`/`indigo-700` hex values, named once) so buttons/links/focus rings reference "brand" rather than repeating "indigo-600" as a magic value across every component, and a `--font-sans` system-font stack (see below).
- **System font stack, no web font.** `ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif` — zero network requests for typography, consistent with "no images or icon fonts" in the design brief (a font file is the same class of decoration-only network dependency an icon font would be).
- **Max-width container in the root layout**: one `<div className="mx-auto max-w-4xl px-4 py-10 sm:px-6">` wrapping `{children}`, so every page (including 26b's future ones) gets consistent reading width and side padding without repeating it.
- **No animation beyond default focus/hover transitions**, per the design brief — `transition-colors` on interactive elements, nothing else. No `outline: none` anywhere in `globals.css` or any component: the brief calls for *default* focus behavior, and a removed focus indicator is a direct Lighthouse accessibility failure (ADR-0029) as well as a real usability regression for keyboard users. `focus-visible:ring-2 focus-visible:ring-brand/40` is additive, layered on top of the browser's own outline, never a replacement for it.
- **Contrast, computed before writing markup**: body text `slate-800` on `white`/`slate-50` (>10:1), muted text `slate-600` (>7:1), links/buttons `indigo-600`/`indigo-700` text or background against white (6.3–7.9:1), status badges using Tailwind's `*-100`/`*-800` pairing convention (6.4–7.2:1 across green/amber/red/blue/slate) — every pairing clears WCAG AA's 4.5:1 for normal text with margin to spare, not by a hair.

## Rejected

- **Plain CSS Modules.** No build-step dependency beyond what Next already ships, and no learning curve for a reader unfamiliar with Tailwind's utility-class vocabulary. Loses a shared design-token vocabulary entirely — every file re-invents its own spacing/color literals, and "does this new button look like the others" becomes a manual cross-file comparison instead of "does it use the same utility classes." For four pages that must visually cohere and a 26b that has to extend the same look with minimal new CSS, that tradeoff runs the wrong way.
- **vanilla-extract (or another CSS-in-JS/zero-runtime CSS library).** Real prior art, and type-safe. Adds its own build integration to review and pin, on top of the one this PR is already adding, for a benefit (type-checked style objects) this app's small, static-shaped UI doesn't need enough to justify a second thing to learn beyond Tailwind's classes.
- **A component library (shadcn/ui, Radix, MUI).** Explicitly out of scope for this PR, per the brief: four pages do not justify a component library, and choosing one is itself an ADR-worthy decision (which primitives, how theming composes, how much of its surface area actually gets used) that would be a second, unrelated decision bundled into this one. If 26b's request-detail/filter/action-button surface turns out to need real interactive primitives (a combobox, a modal, a toast queue) that plain Tailwind utility classes make awkward to hand-roll accessibly, that is the revisit trigger for this rejection specifically — not before.
- **Tailwind v3.** v4's Next.js integration is simpler (a PostCSS plugin plus a CSS `@theme` block, no `tailwind.config.js` content-globbing to keep in sync as pages are added) and is what Tailwind's own docs now lead with for new Next.js projects. No reason to start a brand-new integration on the previous major.

## Consequences

- `web/package.json` gains three new `devDependencies` (build-time only — Tailwind compiles to static CSS in `.next/static`; nothing in the standalone runtime image imports it at runtime, verified by inspecting the built image — see the PR body).
- Every existing vitest suite that asserts on rendered output (`page.test.tsx`, `r/[slug]/page.test.tsx`, `t/[token]/page.test.tsx`) keeps passing unmodified: they check text content and structural markers (`name="subject"`, `"In review"`, an org name), never the absence of a `className`.
- `docker build -f web/Dockerfile .` was run and inspected directly (not just `pnpm build`) before this PR was opened — PR #119's `getDb()`-at-build-time bug was invisible to `next build` alone and only surfaced in the real Docker build, and a new build-step dependency is exactly the kind of change that class of gap could hide something in again.
- Whether to extend ADR-0029's Lighthouse gate to also audit `/t/[token]` and `/app` is a separate decision this ADR does not make; see the PR body for the recommendation.

## Acceptance

- `pnpm --filter @frontdesk/web build` and `docker build -f web/Dockerfile .` both succeed.
- Lighthouse accessibility >= 0.90 on `/` and `/r/<demo-slug>` (ADR-0029's existing gate, unmodified). Run locally the same way the `lighthouse` CI job runs it (real `next build` + `next start`, seeded Postgres, `--only-categories=accessibility`), recorded here rather than only in the PR body, since the review agent's prompt is built from the diff alone:

  ```
  accessibility score for /:                      1.0
  accessibility score for /r/bright-smile-dental:  1.0
  ```

  Confirmed via the same run's per-audit results that `color-contrast`, `button-name`, `label`, and `html-has-lang` each scored 1 individually, not just the rolled-up category score.
- Every existing `web/` vitest suite and both Playwright specs (`web/e2e/submit.spec.ts`, `web/e2e/cross-org-isolation.spec.ts`) stay green with no selector changes.
