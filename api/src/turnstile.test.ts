import { afterEach, describe, expect, it, vi } from "vitest";
import { createTurnstileVerifier } from "./turnstile.js";

// routes/requests.test.ts injects a stub verifier, so the real
// fetch-based implementation had no coverage. These stub global fetch -
// nothing here reaches Cloudflare.
describe("createTurnstileVerifier", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(response: Partial<Response> & { json?: () => Promise<unknown> }) {
    const spy = vi.fn().mockResolvedValue(response);
    vi.stubGlobal("fetch", spy);
    return spy;
  }

  it("posts the secret and token to the siteverify endpoint", async () => {
    const spy = stubFetch({ ok: true, json: async () => ({ success: true }) });
    await createTurnstileVerifier("sekret")("tok");
    const [url, init] = spy.mock.calls[0]!;
    expect(url).toBe("https://challenges.cloudflare.com/turnstile/v0/siteverify");
    expect(init.method).toBe("POST");
    const body = init.body as URLSearchParams;
    expect(body.get("secret")).toBe("sekret");
    expect(body.get("response")).toBe("tok");
    expect(body.get("remoteip")).toBeNull();
  });

  it("includes remoteip when given", async () => {
    const spy = stubFetch({ ok: true, json: async () => ({ success: true }) });
    await createTurnstileVerifier("sekret")("tok", "203.0.113.7");
    expect((spy.mock.calls[0]![1].body as URLSearchParams).get("remoteip")).toBe("203.0.113.7");
  });

  it("returns true on success", async () => {
    stubFetch({ ok: true, json: async () => ({ success: true }) });
    await expect(createTurnstileVerifier("s")("tok")).resolves.toBe(true);
  });

  it("returns false on success:false", async () => {
    stubFetch({
      ok: true,
      json: async () => ({ success: false, "error-codes": ["invalid-input-response"] }),
    });
    await expect(createTurnstileVerifier("s")("tok")).resolves.toBe(false);
  });

  it("returns false on a non-ok HTTP status without parsing the body", async () => {
    const json = vi.fn();
    stubFetch({ ok: false, status: 500, json });
    await expect(createTurnstileVerifier("s")("tok")).resolves.toBe(false);
    expect(json).not.toHaveBeenCalled();
  });

  it("returns false when the body omits success entirely", async () => {
    stubFetch({ ok: true, json: async () => ({}) });
    await expect(createTurnstileVerifier("s")("tok")).resolves.toBe(false);
  });
});
