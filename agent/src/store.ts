/**
 * Durable target store — SQLite (better-sqlite3, synchronous, native).
 *
 * Why SQLite: zero external infra keeps A0 fully isolated from the archive's
 * Postgres (handoff: "stateless workers, durable state"; the agent is a
 * separate deployable). Synchronous better-sqlite3 means transactions are
 * trivially atomic without async races — important for the lease logic.
 *
 * The store owns:
 *  - the `targets` table + state-machine-validated transitions
 *  - leasing (one worker per registrable domain, TTL auto-release)
 *  - idempotent seed ingest (re-load never re-queues confirmed/in-flight)
 *  - funnel stats / coverage
 *
 * Personas are NOT stored: they are a pure deterministic function of the
 * domain (see persona.ts), so there is no pool table to keep in sync.
 */

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  assertTransition,
  isConfirmedOrInFlight,
  isStatus,
  STATUSES,
  type Status,
} from "./state.ts";
import { canonicalizeDomain, brandSlugFromDomain, type SeedRow } from "./canonical.ts";

export interface TargetRow {
  domain: string;
  brand_name: string | null;
  category: string | null;
  status: Status;
  lease_owner: string | null;
  lease_expires_at: number | null; // epoch ms
  attempts: number;
  address_id: number | null;
  address: string | null;
  last_error: string | null;
  created_at: number; // epoch ms
  updated_at: number; // epoch ms
  /** ESP detected on the chosen form (A4 per-ESP success rates). Nullable. */
  esp: string | null;
  /** When the row first reached `submitted` (epoch ms). Confirm-loop latency. */
  submitted_at: number | null;
  /** When the row reached `confirmed` (epoch ms). Confirm-loop latency. */
  confirmed_at: number | null;
}

export interface IngestResult {
  /** Total rows parsed from the input (pre-dedup). */
  parsed: number;
  /** Rows rejected because they had no valid registrable domain. */
  invalid: number;
  /** Distinct registrable domains in the input after canonicalization. */
  distinct: number;
  /** Newly inserted (now `queued`) domains. */
  inserted: number;
  /** Domains already present and left untouched (confirmed / in-flight / etc.). */
  skipped: number;
}

const DEFAULT_LEASE_TTL_MS = 5 * 60_000; // 5 minutes, mirrors the archive's confirmations lease

export class TargetStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  /** Expose the raw handle for advanced/maintenance use (kept narrow). */
  get handle(): Database.Database {
    return this.db;
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS targets (
        domain           TEXT PRIMARY KEY,
        brand_name       TEXT,
        category         TEXT,
        status           TEXT NOT NULL DEFAULT 'queued',
        lease_owner      TEXT,
        lease_expires_at INTEGER,
        attempts         INTEGER NOT NULL DEFAULT 0,
        address_id       INTEGER,
        address          TEXT,
        last_error       TEXT,
        created_at       INTEGER NOT NULL,
        updated_at       INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_targets_status ON targets(status);
      CREATE INDEX IF NOT EXISTS idx_targets_lease ON targets(status, lease_expires_at);
    `);

    // A4 observability columns. Added via idempotent ALTERs so an existing
    // (A0/A1/A2) store upgrades in place without a destructive migration.
    this.addColumnIfMissing("esp", "TEXT");
    this.addColumnIfMissing("submitted_at", "INTEGER");
    this.addColumnIfMissing("confirmed_at", "INTEGER");
  }

  /** Add a column only if it isn't already present (SQLite has no IF NOT EXISTS for columns). */
  private addColumnIfMissing(name: string, type: string): void {
    const cols = this.db.prepare("PRAGMA table_info(targets)").all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === name)) {
      this.db.exec(`ALTER TABLE targets ADD COLUMN ${name} ${type}`);
    }
  }

  // ── Reads ────────────────────────────────────────────────────────────────

  get(domain: string): TargetRow | undefined {
    const row = this.db
      .prepare("SELECT * FROM targets WHERE domain = ?")
      .get(domain) as TargetRow | undefined;
    return row;
  }

  count(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM targets").get() as { n: number }).n;
  }

  /** Funnel counts keyed by status; every known status is present (0 if none). */
  statsByStatus(): Record<Status, number> {
    const out = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<Status, number>;
    const rows = this.db
      .prepare("SELECT status, COUNT(*) AS n FROM targets GROUP BY status")
      .all() as Array<{ status: string; n: number }>;
    for (const r of rows) {
      if (isStatus(r.status)) out[r.status] = r.n;
    }
    return out;
  }

  /** Coverage % = confirmed / total seed. Returns 0 when the store is empty. */
  coveragePct(): number {
    const total = this.count();
    if (total === 0) return 0;
    const confirmed = this.statsByStatus().confirmed;
    return (confirmed / total) * 100;
  }

  /**
   * Confirm-loop latency samples (submit → confirmed) in ms, for every confirmed
   * row that has both timestamps. The metrics layer turns these into p50/p95.
   */
  confirmLatencySamplesMs(): number[] {
    const rows = this.db
      .prepare(
        `SELECT (confirmed_at - submitted_at) AS ms
           FROM targets
          WHERE status = 'confirmed'
            AND submitted_at IS NOT NULL
            AND confirmed_at IS NOT NULL
            AND confirmed_at >= submitted_at`,
      )
      .all() as Array<{ ms: number }>;
    return rows.map((r) => r.ms);
  }

  /**
   * Per-ESP funnel: for each detected ESP, how many targets reached `submitted`
   * (the denominator — we got a form + submitted it) and how many of those went
   * on to `confirmed` (the numerator). Rows with no ESP are bucketed as
   * `unknown`. Drives the per-ESP success-rate metric (which embeds need fixing).
   */
  espFunnel(): Array<{ esp: string; submitted: number; confirmed: number }> {
    const rows = this.db
      .prepare(
        `SELECT COALESCE(esp, 'unknown') AS esp,
                SUM(CASE WHEN submitted_at IS NOT NULL OR status IN ('submitted','confirmed','needs_attention') THEN 1 ELSE 0 END) AS submitted,
                SUM(CASE WHEN status = 'confirmed' THEN 1 ELSE 0 END) AS confirmed
           FROM targets
          WHERE esp IS NOT NULL
          GROUP BY COALESCE(esp, 'unknown')
          ORDER BY submitted DESC`,
      )
      .all() as Array<{ esp: string; submitted: number; confirmed: number }>;
    return rows;
  }

  // ── Seed ingest (idempotent) ───────────────────────────────────────────────

  /**
   * Idempotently load canonicalized seed rows.
   *
   * For each row:
   *  - canonicalize to the registrable domain (collapses www / paths / subdomains)
   *  - reject rows with no valid registrable domain
   *  - dedup within the batch (last non-empty brand_name/category wins for metadata)
   *  - insert as `queued` if new
   *  - if the domain already exists, NEVER re-queue when it is confirmed or
   *    in-flight (attempting/submitted). For other states we leave the row as-is
   *    too — re-loading the seed must never disturb live progress. We only
   *    backfill missing brand_name/category metadata on an existing `queued` row.
   */
  ingest(rows: Iterable<SeedRow>): IngestResult {
    const now = Date.now();

    // Collapse to distinct registrable domains first.
    const distinctMap = new Map<string, { brand_name?: string; category?: string }>();
    let parsed = 0;
    let invalid = 0;
    for (const r of rows) {
      parsed++;
      const domain = canonicalizeDomain(r.domain);
      if (!domain) {
        invalid++;
        continue;
      }
      const prior = distinctMap.get(domain) ?? {};
      distinctMap.set(domain, {
        brand_name: r.brand_name?.trim() || prior.brand_name,
        category: r.category?.trim() || prior.category,
      });
    }

    const insert = this.db.prepare(`
      INSERT INTO targets (domain, brand_name, category, status, attempts, created_at, updated_at)
      VALUES (@domain, @brand_name, @category, 'queued', 0, @now, @now)
      ON CONFLICT(domain) DO NOTHING
    `);
    const backfill = this.db.prepare(`
      UPDATE targets
         SET brand_name = COALESCE(brand_name, @brand_name),
             category   = COALESCE(category, @category),
             updated_at = @now
       WHERE domain = @domain
         AND status = 'queued'
         AND (brand_name IS NULL OR category IS NULL)
    `);

    let inserted = 0;
    let skipped = 0;

    const tx = this.db.transaction(() => {
      for (const [domain, meta] of distinctMap) {
        const existing = this.get(domain);
        if (existing) {
          // Cardinal rule: never re-queue confirmed/in-flight. We also never
          // mutate status for ANY existing row here — only backfill metadata on
          // a still-queued row.
          if (!isConfirmedOrInFlight(existing.status) && existing.status === "queued") {
            backfill.run({
              domain,
              brand_name: meta.brand_name ?? null,
              category: meta.category ?? null,
              now,
            });
          }
          skipped++;
          continue;
        }
        const info = insert.run({
          domain,
          brand_name: meta.brand_name ?? null,
          category: meta.category ?? null,
          now,
        });
        if (info.changes > 0) inserted++;
        else skipped++;
      }
    });
    tx();

    return {
      parsed,
      invalid,
      distinct: distinctMap.size,
      inserted,
      skipped,
    };
  }

  // ── State transitions ──────────────────────────────────────────────────────

  /**
   * Move a target to a new status, enforcing the state machine.
   * @throws IllegalTransitionError on a disallowed transition.
   * @throws Error if the domain is unknown.
   */
  setStatus(
    domain: string,
    to: Status,
    opts: {
      lastError?: string | null;
      addressId?: number | null;
      address?: string | null;
      /** ESP detected on the chosen form (recorded once; never overwritten with null). */
      esp?: string | null;
    } = {},
  ): TargetRow {
    const current = this.get(domain);
    if (!current) throw new Error(`Unknown target: ${domain}`);
    assertTransition(current.status, to);

    const now = Date.now();
    // Leaving `attempting` always clears the lease.
    const clearLease = current.status === "attempting" && to !== "attempting";
    // Latency timestamps: stamp the FIRST time the row reaches each milestone
    // (COALESCE in SQL keeps an earlier value if a later transition revisits it).
    const stampSubmitted = to === "submitted" ? now : null;
    const stampConfirmed = to === "confirmed" ? now : null;

    this.db
      .prepare(
        `UPDATE targets
            SET status = @to,
                last_error = COALESCE(@lastError, last_error),
                address_id = COALESCE(@addressId, address_id),
                address = COALESCE(@address, address),
                esp = COALESCE(@esp, esp),
                submitted_at = COALESCE(submitted_at, @stampSubmitted),
                confirmed_at = COALESCE(confirmed_at, @stampConfirmed),
                lease_owner = CASE WHEN @clearLease THEN NULL ELSE lease_owner END,
                lease_expires_at = CASE WHEN @clearLease THEN NULL ELSE lease_expires_at END,
                updated_at = @now
          WHERE domain = @domain`,
      )
      .run({
        domain,
        to,
        lastError: opts.lastError ?? null,
        addressId: opts.addressId ?? null,
        address: opts.address ?? null,
        esp: opts.esp ?? null,
        stampSubmitted,
        stampConfirmed,
        clearLease: clearLease ? 1 : 0,
        now,
      });

    return this.get(domain)!;
  }

  // ── Leasing ─────────────────────────────────────────────────────────────────

  /**
   * Atomically claim the next `queued` target (or one whose lease has expired)
   * for `workerId`, moving it to `attempting` and stamping a lease TTL.
   *
   * Expired leases are reclaimed in the same statement: a row in `attempting`
   * whose `lease_expires_at < now` is eligible. This is the "auto-released on
   * worker death" guarantee — a dead worker's lease simply lapses.
   *
   * @returns the leased row, or null if nothing is available.
   */
  leaseNext(workerId: string, ttlMs: number = DEFAULT_LEASE_TTL_MS): TargetRow | null {
    const now = Date.now();
    const expiresAt = now + ttlMs;

    const tx = this.db.transaction((): TargetRow | null => {
      const candidate = this.db
        .prepare(
          `SELECT domain, status FROM targets
            WHERE status = 'queued'
               OR (status = 'attempting' AND lease_expires_at IS NOT NULL AND lease_expires_at < @now)
            ORDER BY updated_at ASC
            LIMIT 1`,
        )
        .get({ now }) as { domain: string; status: Status } | undefined;

      if (!candidate) return null;

      // An expired-lease row is already `attempting`; only bump attempts +
      // refresh the lease. A `queued` row transitions queued -> attempting.
      const isReclaim = candidate.status === "attempting";

      this.db
        .prepare(
          `UPDATE targets
              SET status = 'attempting',
                  lease_owner = @workerId,
                  lease_expires_at = @expiresAt,
                  attempts = attempts + 1,
                  updated_at = @now
            WHERE domain = @domain`,
        )
        .run({ workerId, expiresAt, now, domain: candidate.domain });

      void isReclaim; // documented branch; the UPDATE is identical for both
      return this.get(candidate.domain)!;
    });

    return tx();
  }

  /**
   * Atomically claim a SPECIFIC domain for `workerId` (the single-target manual
   * path used by `agent subscribe <domain>`). Honors the same cardinal rules as
   * {@link leaseNext}: a domain is leasable only when it is `queued`, or already
   * `attempting` with a lapsed lease (reclaim). A live lease held by anyone, or
   * a confirmed/terminal/parked row, returns null — never double-leased, never
   * double-subscribed.
   *
   * @returns the leased row, or null if the domain is unknown or not leasable.
   */
  leaseDomain(
    domain: string,
    workerId: string,
    ttlMs: number = DEFAULT_LEASE_TTL_MS,
  ): TargetRow | null {
    const now = Date.now();
    const expiresAt = now + ttlMs;

    const tx = this.db.transaction((): TargetRow | null => {
      const row = this.get(domain);
      if (!row) return null;

      const leasable =
        row.status === "queued" ||
        (row.status === "attempting" &&
          row.lease_expires_at !== null &&
          row.lease_expires_at < now);
      if (!leasable) return null;

      this.db
        .prepare(
          `UPDATE targets
              SET status = 'attempting',
                  lease_owner = @workerId,
                  lease_expires_at = @expiresAt,
                  attempts = attempts + 1,
                  updated_at = @now
            WHERE domain = @domain`,
        )
        .run({ workerId, expiresAt, now, domain });

      return this.get(domain)!;
    });

    return tx();
  }

  /**
   * Sweep expired leases back to `queued` in bulk. Workers also reclaim lazily
   * via {@link leaseNext}, but a maintenance pass can run this proactively.
   * @returns number of leases released.
   */
  releaseExpiredLeases(now: number = Date.now()): number {
    const info = this.db
      .prepare(
        `UPDATE targets
            SET status = 'queued',
                lease_owner = NULL,
                lease_expires_at = NULL,
                updated_at = @now
          WHERE status = 'attempting'
            AND lease_expires_at IS NOT NULL
            AND lease_expires_at < @now`,
      )
      .run({ now });
    return info.changes;
  }

  /**
   * Voluntarily release a lease held by `workerId`, returning the target to
   * `queued`. No-op (returns false) if the worker doesn't hold the lease.
   */
  releaseLease(domain: string, workerId: string): boolean {
    const row = this.get(domain);
    if (!row || row.status !== "attempting" || row.lease_owner !== workerId) return false;
    this.setStatus(domain, "queued");
    return true;
  }

  /**
   * Re-queue parked rows in a given status back to `queued` (maintenance pass).
   *
   * Honors the state machine: only statuses with a legal path back to `queued`
   * are eligible — `needs_attention`, `needs_solver`, `no_form_found`. A
   * confirmed/dead row is NEVER touched (terminal). Returns the count re-queued.
   *
   * `olderThanMs` (optional) limits to rows not updated within the window, so a
   * trickle doesn't immediately re-attempt something just parked.
   */
  requeueParked(
    from: Extract<Status, "needs_attention" | "needs_solver" | "no_form_found">,
    opts: { olderThanMs?: number; limit?: number; now?: number } = {},
  ): number {
    const now = opts.now ?? Date.now();
    const cutoff = opts.olderThanMs !== undefined ? now - opts.olderThanMs : now + 1;
    const limit = opts.limit ?? -1; // -1 = no limit (SQLite LIMIT -1 = all)
    const info = this.db
      .prepare(
        `UPDATE targets
            SET status = 'queued',
                lease_owner = NULL,
                lease_expires_at = NULL,
                updated_at = @now
          WHERE domain IN (
            SELECT domain FROM targets
             WHERE status = @from
               AND updated_at <= @cutoff
             ORDER BY updated_at ASC
             LIMIT @limit
          )`,
      )
      .run({ from, now, cutoff, limit });
    return info.changes;
  }

  /**
   * Reconcile a confirmed address: flip a `submitted` (or late `needs_attention`)
   * row to `confirmed` when the archive confirms its address. This is the local
   * mirror of the archive-side confirm — A5 maintenance reconciles drops here.
   * No-op (returns false) if the domain isn't in a confirmable state.
   */
  markConfirmed(domain: string): boolean {
    const row = this.get(domain);
    if (!row) return false;
    if (row.status !== "submitted" && row.status !== "needs_attention") return false;
    this.setStatus(domain, "confirmed");
    return true;
  }

  /** Count rows in a given status (cheap helper for run modes + metrics). */
  countByStatus(status: Status): number {
    return (
      this.db.prepare("SELECT COUNT(*) AS n FROM targets WHERE status = ?").get(status) as {
        n: number;
      }
    ).n;
  }

  /** True if `workerId` currently holds a live (un-expired) lease on `domain`. */
  holdsLease(domain: string, workerId: string, now: number = Date.now()): boolean {
    const row = this.get(domain);
    return (
      !!row &&
      row.status === "attempting" &&
      row.lease_owner === workerId &&
      row.lease_expires_at !== null &&
      row.lease_expires_at >= now
    );
  }
}
