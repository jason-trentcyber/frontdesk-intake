import { beforeEach, describe, expect, it, vi } from "vitest";

const authMock = vi.fn();
const resolveMembershipMock = vi.fn();
const redirectMock = vi.fn((url: string) => {
  // next/navigation's real redirect() throws a special NEXT_REDIRECT
  // control-flow signal rather than returning - mimicked here so a
  // caller that (incorrectly) kept executing after calling it would
  // fail this test the same way it would fail a real Next render.
  throw new Error(`NEXT_REDIRECT:${url}`);
});

vi.mock("./auth", () => ({ getAuth: () => ({ auth: authMock }) }));
vi.mock("./db", () => ({ getDb: () => ({}) }));
vi.mock("next/navigation", () => ({ redirect: redirectMock }));
vi.mock("@frontdesk/db", () => ({ resolveMembership: resolveMembershipMock }));

const { requireMembershipForAction, requireSessionOrRedirect } = await import("./auth-guard");

describe("requireSessionOrRedirect", () => {
  beforeEach(() => {
    authMock.mockReset();
    resolveMembershipMock.mockReset();
    redirectMock.mockClear();
  });

  it("redirects to sign-in when there is no session at all", async () => {
    authMock.mockResolvedValue(null);
    await expect(requireSessionOrRedirect()).rejects.toThrow("NEXT_REDIRECT:/api/auth/signin");
    expect(resolveMembershipMock).not.toHaveBeenCalled();
  });

  it("returns null (does not redirect, does not throw) for a session with no org_members row", async () => {
    authMock.mockResolvedValue({ user: { email: "staff@example.com" } });
    resolveMembershipMock.mockResolvedValue(null);
    const result = await requireSessionOrRedirect();
    expect(result).toBeNull();
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("returns the membership plus email for a session with a real org_members row", async () => {
    authMock.mockResolvedValue({ user: { email: "owner@example.com" } });
    resolveMembershipMock.mockResolvedValue({ orgId: "org-1", role: "owner" });
    const result = await requireSessionOrRedirect();
    expect(result).toEqual({ orgId: "org-1", role: "owner", email: "owner@example.com" });
  });
});

describe("requireMembershipForAction", () => {
  beforeEach(() => {
    authMock.mockReset();
    resolveMembershipMock.mockReset();
  });

  it("throws (never redirects) when there is no session - a Server Action has no page to redirect", async () => {
    authMock.mockResolvedValue(null);
    await expect(requireMembershipForAction()).rejects.toThrow(/not authenticated/i);
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("throws when there is a session but no org_members row", async () => {
    authMock.mockResolvedValue({ user: { email: "staff@example.com" } });
    resolveMembershipMock.mockResolvedValue(null);
    await expect(requireMembershipForAction()).rejects.toThrow(/not authenticated|not a member/i);
  });

  it("returns the membership plus email for a real org_members row", async () => {
    authMock.mockResolvedValue({ user: { email: "owner@example.com" } });
    resolveMembershipMock.mockResolvedValue({ orgId: "org-2", role: "staff" });
    const result = await requireMembershipForAction();
    expect(result).toEqual({ orgId: "org-2", role: "staff", email: "owner@example.com" });
  });
});
