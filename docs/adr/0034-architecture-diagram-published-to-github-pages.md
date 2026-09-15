# ADR-0034: the architecture diagram is published to GitHub Pages, not served by the app

## Status

decided

## Context

`README.md`'s Architecture section has said `_Diagram pending (M2)._` since the
first commit. A diagram exists — `docs/diagrams/architecture.html`, generated
2026-09-12 by the `archify` CLI from `architecture.json` — but it has never been
committed, and it was authored against ADRs 0001–0025. It has no auth in it,
which is now the most interesting part of the tenancy story (ADR-0031).

The repository is public because people are meant to read it. A reader who lands
on the README today gets prose and no picture of the system. That is the gap
this ADR closes.

Two artifacts, two audiences:

- A **static PNG** in the README, for a reader who will never click anything.
- The **interactive HTML** (pan/zoom, search, relationship tracing, four guided
  views, light/dark), for a reader who wants to explore.

The HTML is a single self-contained 828 KB file with no runtime dependency. It
has to be *served* from somewhere to be useful; a `.html` file rendered through
GitHub's blob view is escaped source, not a page.

## Decision

1. `docs/diagrams/` is committed: `architecture.json` (the source spec),
   `architecture.html` (the delivered artifact), and `architecture-dark.png` /
   `architecture-light.png` (chrome-free exports at 5200×2480).

2. The README embeds the PNG pair with `<picture>` +
   `prefers-color-scheme`, so it matches the reader's GitHub theme.

3. The interactive HTML is published to **GitHub Pages** by
   `.github/workflows/pages.yml`, which uploads `docs/diagrams/` and deploys
   on pushes to `main` that touch that directory. Landing URL:
   `https://jason-trentcyber.github.io/frontdesk-intake/architecture.html`.

4. **PNG, not SVG, in the README.** GitHub's markdown sanitiser strips embedded
   styles and scripts from SVG. The archify SVG export is style-heavy, so it
   would render degraded or blank on the one surface that matters most.

5. `visual-check` sidecars (`*.visual-check.*` — four PNGs, a contact sheet and
   a JSON receipt) are **not** committed; `.gitignore` excludes them. They are
   regenerable evidence, ~700 KB of binary churn on every re-render.

## Consequences

- Enabling Pages (`Settings → Pages → Source → GitHub Actions`) is a human
  action, consistent with `docs/AI-GOVERNANCE.md` — no agent changes repository
  settings. Done 2026-09-15.
- A second public surface now exists on a `github.io` host. It serves one static
  documentation artifact and carries no credential, no API and no tenant data.
- Editing the diagram means editing `architecture.json` and re-running
  `validate` → `deliver` → `visual-check`, then re-exporting both PNGs. The
  regeneration commands are in `docs/diagrams/architecture-assumptions.md`.
- `deploy.yml` already skips docs-only changes, so a diagram edit does not
  trigger a production rollout of the app.

## Alternatives rejected

**Serve it from the app at `frontdesk.jtrent.dev/architecture`.** It is already
public, already deployed, and already the URL handed to readers. Rejected: it
puts an 828 KB documentation brochure inside the production container image, and
couples a documentation edit to a production rollout of the product. `web/`'s
container is sized at 256Mi and exists to serve the intake product, not to host
marketing collateral. Pages keeps documentation out of the runtime image at zero
cost on a public repository.

**Commit only the PNG and drop the HTML.** Rejected: the interactive artifact is
the one that demonstrates the four guided views and the relationship tracing,
and it is the actual output of the generator. Committing only a raster export
would mean the repository could not reproduce its own diagram.

**Render to SVG and inline it in the README.** Rejected under decision 4 above
(GitHub sanitises SVG styling). It was the option with the smallest byte
footprint, and it does not survive contact with GitHub's renderer.

**Mermaid in the README instead of a generated artifact.** GitHub renders
Mermaid natively, which removes both the Pages workflow and the binary assets.
Rejected: at 17 nodes with boundaries, dashed switch-proof alternates and
per-edge protocol labels, Mermaid's automatic layout produces a substantially
less readable result, and there is no validation gate — no crossing count, no
label-clearance check, no containment measurement. The `archify` path gives
composition checks that fail loudly; Mermaid gives whatever `dagre` decides.
