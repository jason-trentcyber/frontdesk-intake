# web

Next.js app: landing, public form, tracking page, staff queue (Auth.js).
Design is **ADR-0021** (the `@frontdesk/db` boundary) and **ADR-0031**
(#26's auth design); read those first, this file only covers day-to-day
mechanics.

## Tests

```
make up                                          # postgres + localstack
pnpm --filter @frontdesk/db migrate
pnpm seed
pnpm --filter @frontdesk/web test                # vitest
pnpm --filter @frontdesk/web exec playwright install chromium   # once
pnpm --filter @frontdesk/web test:e2e            # Playwright (ADR-0030)
```

`vitest` and Playwright are two separate runners with two separate
commands - `web/e2e/` is Playwright's `testDir`, excluded from vitest's
own collection (`web/vitest.config.ts`) so neither picks up the other's
files. Playwright's specs build a real `next build` and spawn the real
standalone `server.js` themselves (matching `web/Dockerfile`), so no
separate build step is needed before `test:e2e`.

Playwright downloads its own bundled Chromium the first time
(`playwright install chromium`) - unconfined, not the OS package
manager's browser. This VPS's only system Chrome is snap-packaged and
cannot be launched as a plain child process outside snap's confinement,
which is exactly what made the old `puppeteer-core`-based e2e test need
a manually-downloaded, out-of-repo Chrome build for local verification
(ADR-0030). Playwright's own bundled browser needs no such workaround,
here or in CI.
