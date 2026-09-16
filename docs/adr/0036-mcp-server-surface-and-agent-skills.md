# ADR-0036: frontdesk exposes a thin MCP server over the existing API-key boundary; Agent Skills are a different layer and do not replace it

Status: decided 2026-09-16; not yet implemented (implementation is a separate issue, sequenced behind #26b)

## Context

frontdesk has no MCP surface today. A grep for `mcp` across the repo returns nothing:
no server, no client, no ADR, no mention in the README or the architecture diagram.
That is a gap worth closing deliberately rather than by default, because the
question "how does an agent reach this system" now has a standard answer and an
active argument about whether that answer is the right one.

### What MCP is, and where it sits

The Model Context Protocol is a JSON-RPC wire format for exposing tools, resources
and prompts to an LLM host. Anthropic published it in November 2024 and donated it
to the Agentic AI Foundation — a directed fund under the Linux Foundation,
co-founded with Block and OpenAI — on 9 December 2025. It is no longer a
single-vendor protocol.

The spec has moved fast, and two revisions matter for anything built now:

- **2025-11-25** hardened authorization. RFC 8707 resource indicators became
  MUST-level for clients, servers MUST only accept tokens whose audience names
  them specifically, and token passthrough — an MCP server reusing the caller's
  inbound token to call an upstream service — is explicitly forbidden.
- **2026-07-28** (RC 21 May 2026, final 28 July 2026) is the largest revision
  since launch. It removes the `initialize` handshake (SEP-2575) and the
  `Mcp-Session-Id` header (SEP-2567), making the protocol stateless at the
  transport layer; adds the Tasks and Apps extensions; and deprecates Roots,
  Sampling and Logging under a new lifecycle policy. Any server we write targets
  this revision, and `tools/list` results now carry `ttlMs`/`cacheScope`
  (SEP-2549), so the tool list is cacheable at the edge rather than held open on
  an SSE stream.

### The backlash, and what it is actually about

Through 2026 a visible group moved away from MCP. Perplexity's CTO said in March
2026 that the company was deprioritizing it internally; Garry Tan argued publicly
that a CLI wrapper he wrote in an afternoon beat the MCP integration it replaced.
The stated reason in nearly every case is context cost, and the numbers are real:
by Anthropic's own published figures, five servers exposing 58 tools consume
roughly 55,000 tokens of context before the agent does anything, and their Tool
Search Tool — which loads tool names first and full schemas on demand — cut that
by about 85% while *raising* tool-selection accuracy on Opus 4 from 49% to 74%.
Their code-execution-with-MCP pattern took one real workflow from 150,000 tokens
to 2,000.

That is a criticism of **flat client-side tool discovery**, not of exposing a
system over a protocol. The failure mode is an agent connected to a dozen rich
servers paying for every schema on every turn. It is not "a multi-tenant SaaS
published three authenticated tools."

Anthropic's own fix confirms the reading: the answer was progressive disclosure
inside the client (Tool Search, code execution), not deleting the servers.

### Agent Skills are a different layer

Agent Skills (announced 16 October 2025, published as an open cross-platform
format 18 December 2025) are folders containing a `SKILL.md` plus optional
scripts and references. They load by progressive disclosure: roughly 100 tokens
of metadata at startup, the body (recommended under 5k tokens) only when
triggered, bundled files only when read.

A Skill carries **no auth model, no session, and no connection**. It ships static
files into context. It cannot reach a system the host could not already reach.
So a Skill can encode *how to triage a frontdesk request*; it cannot be the thing
that authenticates as an org and writes a row. Anthropic states the complementary
position directly, and the 2026-07-28 spec work proceeded in parallel with Skills
adoption rather than in retreat from it.

The honest summary: **Skills displaced a category of MCP server that should never
have been a server** — the ones that wrapped a well-known CLI or a public API the
model already knows how to call, and charged context rent for the privilege.
Servers that front a private, authenticated, multi-tenant system were never in
that category. frontdesk is squarely in the second group.

## Decision

**1. frontdesk will expose an MCP server, and it will be thin.**

A new pnpm workspace package `mcp/` (`@frontdesk/mcp`), built on
`@modelcontextprotocol/sdk`, targeting spec revision 2026-07-28, stdio transport.

**2. The server is an API client, not a second data path.** This is the load-bearing
constraint. `mcp/` may not import `@frontdesk/db`. Every tool call goes out over
HTTP to `api/` carrying the F3 API key (`api/src/routes/requests.ts`), so org
resolution, `forOrg()`, and the RLS policies stay in exactly one place — the place
ADR-0007, ADR-0018 and ADR-0021 already put them. An MCP server that reached the
database directly would be a second tenancy-enforcement surface, and the second
surface is always the one that gets it wrong.

Enforced the way ADR-0024 enforces provider isolation: a test asserting no file
under `mcp/` imports `@frontdesk/db` or `drizzle-orm`.

**3. Authorization is the API key's, unchanged.** The MCP server holds one org's
key, supplied by its environment, exactly as any other F3 integration does. It
never accepts a token from the model or the user and forwards it anywhere — the
practice the 2025-11-25 spec forbids and that 2026-07-28 keeps forbidden.

**4. The tool surface is deliberately small.** Three tools at v1:

| Tool | Backed by | Status |
|---|---|---|
| `submit_request` | `POST /api/v1/orgs/:slug/requests` | exists |
| `get_index_info` | `GET /api/v1/orgs/:slug/index-info` | exists |
| `get_request_status` | `GET /api/v1/orgs/:slug/requests/:trackingToken` | **new route required** |

`get_request_status` closes a genuine F3 gap independent of MCP: an API-key
integration can currently create a request and then has no machine-readable way
to observe its draft, status or citations. Only `web/` can, in-process, via the
tracking page. That route is worth adding whether or not the MCP server ships.

**5. Deferred, named explicitly so the omission is a decision and not an oversight:**

- `search_documents` over the hybrid retrieval index. Highest demonstration
  value, needs a retrieval route on `api/` that does not exist, and raises a real
  question about returning another org's chunk text that deserves its own
  review. Not in v1.
- Streamable-HTTP transport with OAuth 2.1 + PKCE + RFC 8707 resource
  indicators. This is the correct shape for a remote multi-user server and the
  part of MCP that has genuinely matured. It costs an ingress route, a
  container, and memory on a 4 GB single node (ADR-0010) for no gain over stdio
  in the demonstrated scenario. Deferred on node budget, not on principle.
- A companion Skill. If `mcp/` ships, a `SKILL.md` describing *when* to submit
  versus check status is the correct complement to it, and is the pattern this
  ADR argues for. Also not v1.

**6. No MCP inside the worker.** ADR-0023 fixed the triage pipeline at one
process with in-process retrieval and ONNX embeddings. Routing pgvector calls
through a protocol hop would add latency and a failure mode to buy a label.

## Consequences

- One new workspace package, one new dependency, one new API route, one new
  isolation test. No new container, no ingress change, no runtime cost on the
  node.
- `api/` gains a read endpoint for requests, which tightens F3 for every
  integration, not just MCP.
- The README and the architecture diagram (ADR-0034) gain the `mcp/` node once
  it is implemented — **not before**. Claiming an MCP surface the repo does not
  serve is the exact failure this repo's provenance rules exist to prevent.
- If MCP's trajectory reverses further, the loss is one thin package that calls
  a public HTTP API. The API is the durable interface; MCP is one adapter in
  front of it. That is the same bet ADR-0006 makes about LLM providers and
  ADR-0004 makes about queues, and it is the reason this decision is cheap to
  unwind.

## Rejected

- **Do nothing and say the repo already uses MCP because the review agent runs
  Claude Code, which is an MCP client.** It is technically an MCP *host*, but
  `review-agent.yml` configures zero servers and runs with
  `--allowedTools Read,Grep,Glob`. Claiming MCP usage on that basis collapses
  under one follow-up question, and the repo's whole argument is that claims
  survive inspection.
- **A large tool surface mapping every API route to a tool.** This is precisely
  the pattern the 2026 backlash is about: tool count degrades selection accuracy
  and the schemas are charged to context on every turn. Three tools that match
  actual integration use cases beat fifteen that mirror the route table.
- **Let `mcp/` import `@frontdesk/db` for speed.** It removes an HTTP hop and
  creates a second place where tenancy can be got wrong. ADR-0021 already drew
  this line between `web/` and `api/`; the same reasoning applies with more
  force to a surface an autonomous agent drives.
- **Build a Skill instead of a server.** A Skill cannot authenticate or hold a
  connection; it ships files into context. For "let an external agent file a
  request against a tenant it has a key for", a Skill is not a weaker option, it
  is not an option.
- **Ship remote HTTP transport now for the demo.** Memory on a 4 GB node is the
  binding constraint (ADR-0026 already deferred Loki and Alertmanager for the
  same reason), and stdio demonstrates the same architecture.

## Sources

MCP spec revisions 2025-11-25 and 2026-07-28 and their SEPs (modelcontextprotocol.io);
Anthropic, "Donating the Model Context Protocol and establishing the Agentic AI
Foundation", 9 Dec 2025; Anthropic engineering on the Tool Search Tool and code
execution with MCP, Nov 2025 (the 55,000-token, 85%, 49%→74% and 150,000→2,000
figures are theirs); Anthropic Agent Skills documentation for the progressive
disclosure tiers. Ecosystem-size and adoption-share numbers circulating in
secondary commentary are not cited here because they are not independently
verifiable.
