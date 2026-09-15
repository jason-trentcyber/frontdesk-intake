// ADR-0033. Tailwind v4's official Next.js integration: a PostCSS plugin,
// not a tailwind.config.js/content-globbing setup (that was v3). Next's
// own build (Turbopack, this repo's default) has built-in PostCSS support
// and reads this file automatically - no next.config.ts change needed.
const config = {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};

export default config;
