import type { NextRequest } from "next/server";
import { getAuth } from "../../../../lib/auth";

// pg needs Node's TCP/net APIs; Next's default runtime for a dynamic
// route can be Edge, which has neither (same reasoning as every other
// database-backed route in this app).
export const runtime = "nodejs";

// getAuth(), not a top-level `export const { GET, POST } = handlers` -
// see web/src/lib/auth.ts's comment: building NextAuth() eagerly at
// module scope broke `next build` itself (getDb() throws without a
// database URL, which build time never has).
export async function GET(request: NextRequest): Promise<Response> {
  return getAuth().handlers.GET(request);
}

export async function POST(request: NextRequest): Promise<Response> {
  return getAuth().handlers.POST(request);
}
