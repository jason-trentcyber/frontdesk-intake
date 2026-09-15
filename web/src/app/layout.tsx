import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "frontdesk",
  description: "An AI-assisted request desk for small businesses.",
};

// ADR-0033: the one max-width container every page shares, so a new page
// (26b's request detail, filters, action buttons) gets the same reading
// width and side padding for free instead of repeating it per page.
//
// The header/footer live here rather than per-page for the same reason.
// Without them, every surface began at the top-left of an empty slate-50
// field - the single strongest "unfinished" signal in the design review,
// and the one thing no individual page could fix on its own. The flex
// column + `flex-1` on main is what pins the footer to the bottom of
// short pages (the tracking page is ~170px of content in an 800px
// viewport) instead of leaving it floating mid-screen.
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="flex min-h-screen flex-col bg-slate-50 text-slate-800 antialiased">
        <header className="border-b border-slate-200 bg-white">
          <div className="mx-auto flex max-w-4xl items-center gap-2 px-4 py-3 sm:px-6">
            {/* No image asset: a wordmark is one less binary in the repo
                and one less request on the page, and it scales without a
                second file for dark mode or high-DPI. */}
            <Link
              href="/"
              className="flex items-center gap-2 font-semibold text-slate-900 no-underline"
            >
              <span
                aria-hidden="true"
                className="bg-brand inline-flex h-6 w-6 items-center justify-center rounded text-sm leading-none font-bold text-white"
              >
                f
              </span>
              frontdesk
            </Link>
          </div>
        </header>

        <div className="mx-auto w-full max-w-4xl flex-1 px-4 py-10 sm:px-6">{children}</div>

        <footer className="border-t border-slate-200 bg-white">
          <div className="mx-auto max-w-4xl px-4 py-6 text-sm text-slate-600 sm:px-6">
            frontdesk - an AI-assisted request desk. Replies are drafted from a business&apos;s own
            documents and approved by a person before they are sent.
          </div>
        </footer>
      </body>
    </html>
  );
}
