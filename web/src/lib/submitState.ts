// Deliberately its own plain module, not exported from actions.ts.
// actions.ts is a "use server" file, and Next requires every runtime
// export of a "use server" module to be an async function - each one
// becomes a callable server-action endpoint. INITIAL_SUBMIT_STATE is a
// plain object, so exporting it alongside submitPublicRequest made the
// whole module throw at evaluation time ("A 'use server' file can only
// export async functions, found object") the moment anything tried to
// invoke an action from it - which is exactly what shipped in #112 and
// 500'd every real form submission while every test and the Docker
// build stayed green (nothing in CI evaluates this module inside a real
// Next server). See web/src/app/r/[slug]/submit.e2e.test.ts for the
// regression test.
export interface SubmitState {
  status: "idle" | "error";
  message?: string;
}

export const INITIAL_SUBMIT_STATE: SubmitState = { status: "idle" };
