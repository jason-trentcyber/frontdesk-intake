import { describe, expect, it } from "vitest";
import { loadApiOrigin, loadDatabaseUrl, loadTurnstileSiteKey } from "./env";

describe("loadDatabaseUrl", () => {
  it("returns DATABASE_URL when that's all that's set", () => {
    expect(
      loadDatabaseUrl({
        DATABASE_URL: "postgresql://frontdesk:frontdesk@localhost:5432/frontdesk",
      }),
    ).toBe("postgresql://frontdesk:frontdesk@localhost:5432/frontdesk");
  });

  it("prefers DATABASE_APP_URL over DATABASE_URL when both are set (local dev)", () => {
    expect(
      loadDatabaseUrl({
        DATABASE_URL: "postgresql://frontdesk:frontdesk@localhost:5432/frontdesk",
        DATABASE_APP_URL: "postgresql://frontdesk_app:frontdesk_app@localhost:5432/frontdesk",
      }),
    ).toBe("postgresql://frontdesk_app:frontdesk_app@localhost:5432/frontdesk");
  });

  it("throws when neither is set - does not require API_ORIGIN/TURNSTILE_SITE_KEY at all", () => {
    expect(() => loadDatabaseUrl({})).toThrow(/DATABASE_URL/);
  });
});

describe("loadApiOrigin", () => {
  it("returns API_ORIGIN when set", () => {
    expect(loadApiOrigin({ API_ORIGIN: "http://frontdesk-api:80" })).toBe(
      "http://frontdesk-api:80",
    );
  });

  it("throws when missing - no default that would silently call the wrong place", () => {
    expect(() => loadApiOrigin({})).toThrow(/API_ORIGIN/);
  });
});

describe("loadTurnstileSiteKey", () => {
  it("returns TURNSTILE_SITE_KEY when set", () => {
    expect(loadTurnstileSiteKey({ TURNSTILE_SITE_KEY: "0xsitekey" })).toBe("0xsitekey");
  });

  it("throws when missing", () => {
    expect(() => loadTurnstileSiteKey({})).toThrow(/TURNSTILE_SITE_KEY/);
  });
});
