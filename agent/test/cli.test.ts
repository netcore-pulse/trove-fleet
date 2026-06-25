import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli/index.ts";
import { syntheticSeed, toSeedCsv } from "./helpers/seed-gen.ts";

describe("CLI — seed + stats end to end", () => {
  let dir: string;
  let dbPath: string;
  let seedPath: string;
  let stdout: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "trove-agent-cli-"));
    dbPath = join(dir, "targets.db");
    seedPath = join(dir, "seed.csv");
    process.env.TROVE_AGENT_DB = dbPath;
    stdout = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
      return true;
    });
    // Silence the CLI's stderr (usage/errors) so test output stays clean.
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.TROVE_AGENT_DB;
    rmSync(dir, { recursive: true, force: true });
  });

  it("`agent seed <file>` loads a 1K seed, dedups, reports inserted=1000", () => {
    const seed = syntheticSeed(1000);
    writeFileSync(seedPath, toSeedCsv(seed.rows), "utf8");

    const code = run(["seed", seedPath]);
    expect(code).toBe(0);
    expect(stdout).toMatch(/distinct: 1000/);
    expect(stdout).toMatch(/inserted: 1000/);
    expect(stdout).toMatch(/total now 1000/);
  });

  it("`agent stats` reports the funnel after a seed", () => {
    const seed = syntheticSeed(1000);
    writeFileSync(seedPath, toSeedCsv(seed.rows), "utf8");
    run(["seed", seedPath]);
    stdout = "";

    const code = run(["stats"]);
    expect(code).toBe(0);
    expect(stdout).toMatch(/Total: 1000/);
    expect(stdout).toMatch(/queued\s+1000/);
    expect(stdout).toMatch(/Coverage \(confirmed\/total\): 0\.00%/);
  });

  it("re-seeding the same file is idempotent (inserted=0 second time)", () => {
    const seed = syntheticSeed(100);
    writeFileSync(seedPath, toSeedCsv(seed.rows), "utf8");
    run(["seed", seedPath]);
    stdout = "";
    const code = run(["seed", seedPath]);
    expect(code).toBe(0);
    expect(stdout).toMatch(/inserted: 0/);
    expect(stdout).toMatch(/skipped:  100/);
  });

  it("`agent persona <domain>` prints a deterministic synthetic persona", () => {
    const code = run(["persona", "nike.com"]);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.domain).toBe("nike.com");
    expect(parsed.persona.postalCode).toMatch(/^\d{5}$/);
  });

  it("unknown command exits non-zero", () => {
    const code = run(["frobnicate"]);
    expect(code).toBe(2);
  });
});
