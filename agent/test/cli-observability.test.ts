/**
 * CLI tests for the A4 observability commands (`metrics`, `doctor`). These are
 * pure-read (store + env proxy pool), so — unlike burst/maintain which drive a
 * real browser — they run in the offline suite.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli/index.ts";
import { TargetStore } from "../src/store.ts";

describe("CLI — A4 metrics + doctor", () => {
  let dir: string;
  let dbPath: string;
  let stdout: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "trove-agent-obs-"));
    dbPath = join(dir, "targets.db");
    process.env.TROVE_AGENT_DB = dbPath;
    delete process.env.TROVE_PROXY_URLS;
    stdout = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.TROVE_AGENT_DB;
    delete process.env.TROVE_PROXY_URLS;
    rmSync(dir, { recursive: true, force: true });
  });

  function seedAndWalk(): void {
    const store = new TargetStore(dbPath);
    store.ingest(Array.from({ length: 10 }, (_, i) => ({ domain: `brand${i}.com` })));
    // 3 confirmed, 2 submitted, 1 needs_solver.
    for (const d of ["brand0.com", "brand1.com", "brand2.com"]) {
      store.setStatus(d, "attempting");
      store.setStatus(d, "submitted", { esp: "klaviyo" });
      store.setStatus(d, "confirmed");
    }
    for (const d of ["brand3.com", "brand4.com"]) {
      store.setStatus(d, "attempting");
      store.setStatus(d, "submitted", { esp: "mailchimp" });
    }
    store.setStatus("brand5.com", "attempting");
    store.setStatus("brand5.com", "needs_solver");
    store.close();
  }

  it("`agent metrics` prints the funnel, coverage, and per-ESP rows", () => {
    seedAndWalk();
    const code = run(["metrics"]);
    expect(code).toBe(0);
    expect(stdout).toContain("Total seed: 10");
    expect(stdout).toMatch(/Coverage \(confirmed\/total\): 30\.00%/);
    expect(stdout).toMatch(/confirmed\s+3/);
    expect(stdout).toMatch(/needs_solver\s+1/);
    expect(stdout).toMatch(/klaviyo/);
    expect(stdout).toMatch(/Proxies: 1\/1 healthy/); // null pool (direct)
  });

  it("`agent doctor` exits 0 when healthy", () => {
    seedAndWalk();
    const code = run(["doctor"]);
    expect(code).toBe(0);
    expect(stdout).toContain("doctor");
    // Default thresholds: 3 confirmed / 5 submitted-or-confirmed = 60% > 40% → no collapse.
    expect(stdout).toContain("No alerts");
  });

  it("`agent doctor` exits non-zero on a critical alert (confirm-loop stall)", () => {
    const store = new TargetStore(dbPath);
    store.ingest(Array.from({ length: 60 }, (_, i) => ({ domain: `brand${i}.com` })));
    // 50 submitted, 0 confirmed → confirm-loop stall (critical).
    for (let i = 0; i < 50; i++) {
      const d = `brand${i}.com`;
      store.setStatus(d, "attempting");
      store.setStatus(d, "submitted");
    }
    store.close();

    const code = run(["doctor"]);
    expect(code).toBe(1);
    expect(stdout).toMatch(/confirm_loop_stall/);
  });

  it("metrics with TROVE_PROXY_URLS reports the proxy pool", () => {
    process.env.TROVE_PROXY_URLS = "http://a:1,http://b:2,http://c:3";
    seedAndWalk();
    const code = run(["metrics"]);
    expect(code).toBe(0);
    expect(stdout).toMatch(/Proxies: 3\/3 healthy/);
  });

  it("help lists the new commands", () => {
    const code = run(["help"]);
    expect(code).toBe(0);
    expect(stdout).toContain("agent metrics");
    expect(stdout).toContain("agent doctor");
    expect(stdout).toContain("agent burst");
    expect(stdout).toContain("agent maintain");
  });
});
