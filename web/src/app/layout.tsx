import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "frontdesk",
  description: "An AI-assisted request desk for small businesses.",
};

// ADR-0033: the one max-width container every page shares, so a new page
// (26b's request detail, filters, action buttons) gets the same reading
// width and side padding for free instead of repeating it per page.
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-50 text-slate-800 antialiased">
        <div className="mx-auto max-w-4xl px-4 py-10 sm:px-6">{children}</div>
      </body>
    </html>
  );
}
