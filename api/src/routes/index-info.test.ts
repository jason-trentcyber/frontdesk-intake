import { randomUUID } from "node:crypto";
import { createDb, type Db } from "@frontdesk/db";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import type { Queue, TriageMessage } from "../queue/index.js";

const appUrl = process.env.DATABASE_APP_URL ?? process.env.DATABASE_URL;
const hasEnv = Boolean(appUrl);

class NoopQueue implements Queue<TriageMessage> {
  async send(): Promise<string> {
    return randomUUID();
  }
  async receive(): Promise<never[]> {
    return [];
  }
  async ack(): Promise<void> {}
  async nack(): Promise<void> {}
  async deadLetter(): Promise<void> {}
}

describe.skipIf(!hasEnv)(
  hasEnv ? "GET /api/v1/orgs/:slug/index-info" : "GET /api/v1/orgs/:slug/index-info [skipped: DATABASE_APP_URL/DATABASE_URL not set]",
  () => {
    let db: Db;

    beforeAll(() => {
      db = createDb(appUrl!);
    });

    function testApp() {
      return buildApp({
        db,
        queue: new NoopQueue(),
        verifyTurnstile: async () => true,
        publicWebOrigin: "https://frontdesk.jtrent.dev",
      });
    }

    it("demo org -> 200 with model/dims/index params and live counts", async () => {
      const app = testApp();
      const res = await app.inject({ method: "GET", url: "/api/v1/orgs/bright-smile-dental/index-info" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toMatchObject({
        embeddingModel: "BAAI/bge-small-en-v1.5",
        embeddingDimensions: 384,
        index: { type: "hnsw", distance: "cosine", m: 16, efConstruction: 64 },
      });
      expect(typeof body.documentCount).toBe("number");
      expect(typeof body.chunkCount).toBe("number");
    });

    it("non-demo org -> 404", async () => {
      const app = testApp();
      const res = await app.inject({ method: "GET", url: "/api/v1/orgs/harbor-legal/index-info" });
      expect(res.statusCode).toBe(404);
      expect(res.headers["content-type"]).toContain("application/problem+json");
    });

    it("unknown org -> 404", async () => {
      const app = testApp();
      const res = await app.inject({ method: "GET", url: `/api/v1/orgs/${randomUUID()}/index-info` });
      expect(res.statusCode).toBe(404);
    });
  },
);
