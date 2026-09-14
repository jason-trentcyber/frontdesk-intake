/**
 * ADR-0028: every published port in every compose file names an explicit
 * bind address. The short `"5432:5432"` form binds 0.0.0.0, and Docker's
 * published ports are DNAT'd through FORWARD, never INPUT - so a host
 * firewall rule reports success and enforces nothing. On 2026-09-13 that
 * combination cost the local database (#108).
 *
 * This is a repo-wide invariant with no repo-wide test runner (root
 * `pnpm test` is `pnpm -r test`). It lives in db/ because db/ owns the
 * local Postgres contract that compose.yaml serves, following the same
 * precedent as api/'s tests asserting on docs/contracts/. Full reasoning,
 * including the alternatives rejected, is in
 * docs/adr/0028-compose-loopback-port-bindings.md - not repeated here, so
 * the two cannot drift.
 *
 * Deliberately regex, not a YAML parse: adding a YAML dependency to db/ to
 * enforce a fifteen-character rule would itself need an ADR.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");

const SKIP_DIRS = new Set(["node_modules", ".git", ".venv", "dist", ".next"]);

function composeFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      composeFiles(full, found);
    } else if (/^(docker-)?compose(\.[\w-]+)?\.ya?ml$/.test(entry)) {
      found.push(full);
    }
  }
  return found;
}

/**
 * Published-port entries in a `ports:` block, ignoring comments and the
 * long (`target:`/`published:`) form, which names its bind address in a
 * `host_ip:` key and is not what anyone types by accident.
 */
function shortFormPorts(text: string): string[] {
  const lines = text.split("\n");
  const published: string[] = [];
  let inPorts = false;
  let portsIndent = 0;

  for (const line of lines) {
    if (/^\s*#/.test(line) || line.trim() === "") continue;
    const indent = line.length - line.trimStart().length;

    if (/^\s*ports:\s*$/.test(line)) {
      inPorts = true;
      portsIndent = indent;
      continue;
    }
    if (!inPorts) continue;
    if (indent <= portsIndent) {
      inPorts = false;
      continue;
    }

    const item = line.trim().match(/^-\s*["']?([^"'#]+?)["']?\s*$/);
    const mapping = item?.[1];
    if (mapping !== undefined) published.push(mapping);
  }
  return published;
}

describe("ADR-0028: compose published ports bind explicitly", () => {
  const files = composeFiles(REPO_ROOT);

  it("finds the compose files it is meant to be guarding", () => {
    expect(files.length).toBeGreaterThan(0);
    expect(files.map((f) => relative(REPO_ROOT, f))).toContain("compose.yaml");
  });

  it.each(files)("%s publishes no port on all interfaces", (file) => {
    const violations = shortFormPorts(readFileSync(file, "utf8")).filter(
      (mapping) => !mapping.startsWith("127.0.0.1:") && !mapping.startsWith("[::1]:"),
    );

    expect(
      violations,
      `${relative(REPO_ROOT, file)}: published on all interfaces - ` +
        `prefix with 127.0.0.1: or add an ADR (ADR-0028)`,
    ).toEqual([]);
  });
});
