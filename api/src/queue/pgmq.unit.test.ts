import type { Db } from "@frontdesk/db";
import { describe, expect, it, vi } from "vitest";
import { PostgresQueue } from "./pgmq.js";

// Parity with sqs.unit.test.ts: the contract test covers both adapters
// against real services, this covers the defensive branch a working
// server never reaches. pgmq.send() returning zero rows would mean the
// extension changed shape under us - better a loud throw than an
// undefined id handed back as a message id.
describe("PostgresQueue.send when pgmq returns no rows", () => {
  it("throws naming the queue rather than returning undefined", async () => {
    const db = { execute: vi.fn().mockResolvedValue({ rows: [] }) } as unknown as Db;
    const queue = new PostgresQueue<{ hello: string }>(db, "frontdesk_triage_probe");
    await expect(queue.send({ hello: "x" })).rejects.toThrow(
      /frontdesk_triage_probe.*returned no rows/,
    );
  });
});
