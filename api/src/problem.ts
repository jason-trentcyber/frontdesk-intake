import type { FastifyReply } from "fastify";

// RFC 9457 (obsoletes RFC 7807) "Problem Details for HTTP APIs"
// (docs/conventions.md -> Code style: "The API returns RFC 9457 problem
// details.").
export interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
}

const PROBLEM_CONTENT_TYPE = "application/problem+json";

export function sendProblem(reply: FastifyReply, status: number, title: string, detail?: string): FastifyReply {
  const problem: Problem = { type: "about:blank", title, status, ...(detail ? { detail } : {}) };
  return reply.code(status).type(PROBLEM_CONTENT_TYPE).send(problem);
}
