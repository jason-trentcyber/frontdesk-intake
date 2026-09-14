import { describe, expect, it } from "vitest";
import { loadEnv } from "./env";

const VALID: Record<string, string> = {
  DATABASE_URL: "postgresql://frontdesk:frontdesk@localhost:5432/frontdesk",
  API_ORIGIN: "http://frontdesk-api:80",
  TURNSTILE_SITE_KEY: "0xsitekey",
};

describe("loadEnv", () => {
  it("returns all three values when everything is set", () => {
    expect(loadEnv(VALID)).toEqual({
      databaseUrl: VALID.DATABASE_URL,
      apiOrigin: VALID.API_ORIGIN,
      turnstileSiteKey: VALID.TURNSTILE_SITE_KEY,
    });
  });

  it("prefers DATABASE_APP_URL over DATABASE_URL when both are set (local dev)", () => {
    const env = loadEnv({ ...VALID, DATABASE_APP_URL: "postgresql://frontdesk_app:frontdesk_app@localhost:5432/frontdesk" });
    expect(env.databaseUrl).toBe("postgresql://frontdesk_app:frontdesk_app@localhost:5432/frontdesk");
  });

  it("throws when neither DATABASE_URL nor DATABASE_APP_URL is set", () => {
    expect(() =>
      loadEnv({ API_ORIGIN: VALID.API_ORIGIN, TURNSTILE_SITE_KEY: VALID.TURNSTILE_SITE_KEY }),
    ).toThrow(/DATABASE_URL/);
  });

  it("throws when API_ORIGIN is missing - no default that would silently call the wrong place", () => {
    expect(() =>
      loadEnv({ DATABASE_URL: VALID.DATABASE_URL, TURNSTILE_SITE_KEY: VALID.TURNSTILE_SITE_KEY }),
    ).toThrow(/API_ORIGIN/);
  });

  it("throws when TURNSTILE_SITE_KEY is missing", () => {
    expect(() => loadEnv({ DATABASE_URL: VALID.DATABASE_URL, API_ORIGIN: VALID.API_ORIGIN })).toThrow(
      /TURNSTILE_SITE_KEY/,
    );
  });
});
