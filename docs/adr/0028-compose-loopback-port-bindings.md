# ADR-0028: compose publishes every port on `127.0.0.1` explicitly; a host firewall is not a control for a Docker-published port

Status: decided 2026-09-14

New decision. Constrains `compose.yaml` and any future compose file in this
repo. Does not amend ADR-0013 (admin access over the tailnet), which governs
the *host* firewall and is unchanged.

## Context

On 2026-09-13 the local `frontdesk` database on the development host was
dropped and replaced with a ransom note. Nothing in the cluster was touched;
the loss was a local development database with fictional seed data
(ADR-0007: two orgs, six requests, eight documents), restored by
`make db-reset`. The cost was an evening. The reason it is an ADR and not a
one-line commit is the *mechanism*, which generalises to every port this
repo will ever publish.

**1. `compose.yaml` published both services on all interfaces.** The
mappings were `"5432:5432"` and `"4566:4566"`. A bare `host:container`
mapping binds `0.0.0.0` — the short form's default, not an oversight in
Docker, but an oversight in how it was read. The development host has a
public IP, so Postgres and LocalStack's unauthenticated AWS-compatible
edge API were both reachable from the internet.

**2. The credential was the committed default.** `.env.example` carries
`POSTGRES_USER=postgres` / `POSTGRES_PASSWORD=postgres`, as a complete
example file should (docs/conventions.md, §Configuration). A local `.env`
starts as a copy of it. The published default of a public repository is
not a secret; it is a documented credential. Combined with (1), the
database was open to anyone who scanned the port.

**3. The host firewall rule that was added enforced nothing, and said it
had.** This is the part worth recording.

Docker implements published ports with DNAT: rules in `nat/PREROUTING`
send matching traffic into the `DOCKER` chain, which translates the
destination and forwards it to the container. Translated traffic is
*forwarded*, so it traverses the `FORWARD` chain. It never enters `INPUT`.

ufw's rules live in `INPUT`. So:

```
sudo ufw deny 5432        -> "Rule added"
sudo ufw status           -> 5432  DENY  Anywhere
                          (the port is still reachable from the internet)
```

The command succeeded, the rule was listed, and the port stayed open. A
control that reports success and enforces nothing is worse than no control
at all: it terminates the investigation. Whoever reads `ufw status` next
concludes the port is closed and moves on. The absence of a rule would at
least have prompted the question.

**4. The same trap was then walked into a second time, in the other
direction.** Later the same evening a default-deny ufw policy was enabled
on the development host (`DEFAULT_INPUT_POLICY="DROP"`, allowing only
2222/tcp, 80/tcp, 443/tcp). Because those allows named no interface and
the tailnet was not among them, inbound Tailscale traffic — the *actual*
admin path under ADR-0013 — was dropped, and UDP 41641 with it, costing
the direct WireGuard path and falling back to DERP relay. SSH survived
only because it runs on 2222. The lesson is symmetric with (3): on a host
where Docker owns part of the packet path and Tailscale owns another,
host-wide firewall rules do not mean what a reading of them suggests.

## Decision

### 1. Every published port in every compose file in this repo names an explicit bind address

```yaml
ports:
  - "127.0.0.1:5432:5432"
  - "127.0.0.1:4566:4566"
```

Never the short `"5432:5432"` form. If a service genuinely needs to be
reachable off-host, that is an ADR, not a compose edit.

Every current consumer of these ports is local: `make test`, the
`migrate` and `seed` targets, `psql`, and the SQS adapter contract tests
(ADR-0004). Nothing off-host needs either port, and nothing is expected
to.

### 2. The bind address is the control; a host firewall is not

With a loopback bind, Docker installs no DNAT rule accepting off-host
traffic, so there is nothing for a firewall to be asked to block. The
control is in the same file as the thing it controls, it is versioned,
and it is reviewable in a diff — none of which is true of a rule typed
into a shell on one host.

Correspondingly: **no ADR, issue, or PR in this repo may cite a host
firewall rule as the reason a container port is safe.** If the port is
published on `0.0.0.0`, it is public, whatever `ufw status` prints.

### 3. The reasoning lives inline in `compose.yaml`

A comment above each binding states that the short form binds `0.0.0.0`,
that Docker's DNAT bypasses ufw's `INPUT` chain, and that this port was
exploited on 2026-09-13. The next person to write `"5432:5432"` has to
delete an explanation of why not, rather than merely fail to know.

### 4. The host firewall on the development host is out of scope here

It is a human-operated control on a machine that is not part of this
system's deployment. ADR-0013 governs admin access. No agent modifies it.

## Consequences

- Any future compose service needing off-host access surfaces as an ADR,
  which is the intent.
- A developer who wants to reach the database from another machine
  (a GUI client on a laptop) tunnels over SSH or the tailnet rather than
  publishing the port. That is a per-developer workflow, not a repo change.
- This repository's compose file is now safe to run on a host with a
  public IP. It previously was not, and nothing in it said so.
- The incident's root cause is recorded next to the fix, so the
  "harmless local dev container" framing does not quietly return.

## Rejected

- **Fix it with a host firewall rule (the original response).** Rejected
  empirically: it was tried on 2026-09-13 and enforced nothing, for the
  DNAT reason above. This is the ADR's central finding, not a
  hypothetical.

- **Rules in Docker's `DOCKER-USER` chain, or `ufw-docker`.** These do
  work — `DOCKER-USER` is consulted before Docker's own `FORWARD` rules.
  Rejected anyway: it is host-local configuration solving a problem that a
  fifteen-character change to a versioned file eliminates entirely. It
  would have to be reapplied on every new development host, it is
  invisible in code review, and it leaves the port genuinely open with a
  filter in front of it rather than never opening it. Depth here buys
  nothing over not opening the port.

- **`iptables: false` in the daemon config.** Larger blast radius than the
  problem: it disables Docker's networking rules wholesale, breaking
  inter-container connectivity and requiring hand-maintained NAT. A
  drastic global setting to avoid typing a bind address.

- **Generate a random Postgres password at first run instead of shipping a
  default.** Tempting because two controls failed here, not one. Rejected:
  it makes `.env.example` incomplete, contradicting docs/conventions.md
  ("`.env.example` is complete and committed"), and it adds first-run
  friction to every clone of a public reference implementation in exchange
  for defence against an exposure that decision 1 removes. The default
  credential is only dangerous on a reachable port. Keep the port
  unreachable and the defaults readable. **Revisit if** a compose service
  is ever deliberately published beyond loopback — at that point the
  credential becomes the only remaining control and must stop being a
  documented one.

- **Treat this as a local-dev matter not worth an ADR.** The database that
  was destroyed was disposable; the reasoning error was not. "The firewall
  says the port is closed" is a conclusion that would have been drawn again
  on the cluster, where the data is not fictional.
