import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StatusBadge } from "./StatusBadge";

// A pure lookup (status string -> Tailwind classes) - no database or
// session needed, unlike the page that renders it
// (web/src/app/app/page.tsx), which is covered end to end instead by
// web/e2e/cross-org-isolation.spec.ts.
describe("StatusBadge", () => {
  it.each([
    ["received", "bg-slate-100"],
    ["triaging", "bg-blue-100"],
    ["drafted", "bg-blue-100"],
    ["needs_human", "bg-amber-100"],
    ["approved", "bg-green-100"],
    ["rejected", "bg-red-100"],
  ] as const)("renders the mapped class for status %s", (status, expectedClass) => {
    const html = renderToStaticMarkup(<StatusBadge status={status} />);
    expect(html).toContain(expectedClass);
    expect(html).toContain(status);
  });

  it("falls back to the neutral badge style for an unmapped status", () => {
    const html = renderToStaticMarkup(<StatusBadge status="some-future-status" />);
    expect(html).toContain("bg-slate-100");
    expect(html).toContain("some-future-status");
  });
});
