// F1: the public form calling server-side (ADR-0021). Injectable so
// routes/requests.test.ts can substitute a stub - tests never call the
// real Cloudflare endpoint.
export type TurnstileVerifier = (token: string, remoteIp?: string) => Promise<boolean>;

const VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export function createTurnstileVerifier(secretKey: string): TurnstileVerifier {
  return async (token, remoteIp) => {
    const body = new URLSearchParams({ secret: secretKey, response: token });
    if (remoteIp) {
      body.set("remoteip", remoteIp);
    }
    const res = await fetch(VERIFY_URL, { method: "POST", body });
    if (!res.ok) {
      return false;
    }
    const data = (await res.json()) as { success?: boolean };
    return data.success === true;
  };
}
