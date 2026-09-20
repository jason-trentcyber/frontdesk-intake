import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { submitPublicRequest } from "./actions";
import { INITIAL_SUBMIT_STATE } from "./submitState";

// Only API_ORIGIN - submitPublicRequest calls loadApiOrigin(), not the
// old combined loadEnv(), so it has no reason to need DATABASE_URL or
// TURNSTILE_SITE_KEY at all (review, #112: loadEnv() bundling all three
// forced every consumer, including this one, to provide vars it never
// used).
const ENV_KEYS = ["API_ORIGIN"] as const;
const originalEnv: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) originalEnv[key] = process.env[key];
  process.env.API_ORIGIN = "http://frontdesk-api:80";
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  vi.unstubAllGlobals();
});

function formData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

const VALID_FIELDS = {
  subject: "Need an appointment",
  body: "Do you have anything next week?",
  "cf-turnstile-response": "a-real-token",
};

describe("submitPublicRequest", () => {
  it("rejects a submission missing subject/body without calling fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await submitPublicRequest(
      "bright-smile-dental",
      INITIAL_SUBMIT_STATE,
      formData({ ...VALID_FIELDS, subject: "" }),
    );

    expect(result).toEqual({ status: "error", message: "Subject and message are both required." });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a submission with no Turnstile token without calling fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await submitPublicRequest(
      "bright-smile-dental",
      INITIAL_SUBMIT_STATE,
      formData({ ...VALID_FIELDS, "cf-turnstile-response": "" }),
    );

    expect(result.status).toBe("error");
    expect(result.message).toMatch(/verification/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts exactly the fields api/'s schema expects, to the API_ORIGIN + slug path", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ trackingUrl: "http://localhost:3000/t/abc123" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      submitPublicRequest(
        "bright-smile-dental",
        INITIAL_SUBMIT_STATE,
        formData({ ...VALID_FIELDS, requesterName: "Ana", requesterEmail: "ana@example.com" }),
      ),
      // redirect() throws a Next control-flow signal on success.
    ).rejects.toBeTruthy();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://frontdesk-api:80/api/v1/orgs/bright-smile-dental/requests");
    expect(JSON.parse(init.body as string)).toEqual({
      subject: VALID_FIELDS.subject,
      body: VALID_FIELDS.body,
      "cf-turnstile-response": VALID_FIELDS["cf-turnstile-response"],
      requesterName: "Ana",
      requesterEmail: "ana@example.com",
    });
  });

  it("omits requesterName/requesterEmail from the payload when left blank", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ trackingUrl: "http://localhost:3000/t/abc123" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      submitPublicRequest("bright-smile-dental", INITIAL_SUBMIT_STATE, formData(VALID_FIELDS)),
    ).rejects.toBeTruthy();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const sent = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(sent).not.toHaveProperty("requesterName");
    expect(sent).not.toHaveProperty("requesterEmail");
  });

  it("maps a 403 (Turnstile failed server-side) to a verification error message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 403 }));

    const result = await submitPublicRequest(
      "bright-smile-dental",
      INITIAL_SUBMIT_STATE,
      formData(VALID_FIELDS),
    );

    expect(result.status).toBe("error");
    expect(result.message).toMatch(/verification/i);
  });

  it("maps a 404 (unknown org) to a not-accepting-requests message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));

    const result = await submitPublicRequest(
      "no-such-org",
      INITIAL_SUBMIT_STATE,
      formData(VALID_FIELDS),
    );

    expect(result.status).toBe("error");
    expect(result.message).toMatch(/accepting/i);
  });

  it("maps any other failure status, and a network error, to the same generic message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    const serverErrorResult = await submitPublicRequest(
      "bright-smile-dental",
      INITIAL_SUBMIT_STATE,
      formData(VALID_FIELDS),
    );
    expect(serverErrorResult).toEqual({
      status: "error",
      message: "Something went wrong. Please try again.",
    });

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED")));
    const networkErrorResult = await submitPublicRequest(
      "bright-smile-dental",
      INITIAL_SUBMIT_STATE,
      formData(VALID_FIELDS),
    );
    expect(networkErrorResult).toEqual({
      status: "error",
      message: "Something went wrong. Please try again.",
    });
  });
});
