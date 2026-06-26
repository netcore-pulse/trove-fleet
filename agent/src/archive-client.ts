/**
 * Archive client — the two HTTP seams the agent shares with the Rails archive,
 * plus their helpers. Coded EXACTLY to the frozen internal API contract
 * (see app/controllers/internal/*.rb). No invented endpoints.
 *
 * Trust boundary: the agent never holds object-store creds; it reads raw .eml
 * bytes through /internal/blobs (the archive proxies them). All calls carry
 * `Authorization: Bearer <token>`.
 *
 * In A0 these are exercised against a stubbed `fetch` (no live archive). The
 * client takes an injectable `fetch` so tests stub at the HTTP boundary.
 */

import type { AgentConfig } from "./config.ts";

// ── Contract response shapes (frozen) ────────────────────────────────────────

/** Address serializer shape from Internal::AddressesController#serialize. */
export interface AddressResponse {
  id: number;
  address: string;
  status: string;
  brand_id: number;
  brand_slug: string;
  minted_at: string | null;
  confirm_deadline: string | null;
  confirmed_at: string | null;
}

/**
 * Confirmation queue item. Two archive backends serve this with different
 * shapes, and the confirm loop tolerates BOTH (fields are optional accordingly):
 *
 *  - Rails (Internal::ConfirmationsController#serialize): the agent fetches the
 *    raw .eml via `raw_eml_key`/`raw_eml_url` and extracts the confirm link
 *    itself. `address` is the nested address object.
 *  - Cloudflare archive: the Worker extracts the confirm link AT INGEST and
 *    serves it directly as `confirm_url` (no blob fetch), with `address_id` flat.
 */
export interface ConfirmationResponse {
  id: number;
  status?: string;
  // Rails contract.
  address?: {
    id: number;
    address: string;
    brand_slug: string;
    status: string;
  };
  raw_eml_key?: string | null;
  claimed_by?: string | null;
  claimed_at?: string | null;
  created_at?: string;
  raw_eml_url?: string | null;
  // Cloudflare contract (confirm link pre-extracted at ingest).
  address_id?: number;
  confirm_url?: string | null;
}

/** Brand payload for minting — matches `params.require(:brand).permit(...)`. */
export interface BrandInput {
  slug: string;
  name?: string | undefined;
  primary_domain?: string | undefined;
  category?: string | undefined;
}

/**
 * A burst pass's outcomes, posted to the archive so they survive the ephemeral
 * fleet runner. `by_status` is the funnel (submitted/no_form_found/needs_solver/…);
 * `by_esp` is the per-ESP submitted/confirmed breakdown (where Klaviyo conversions show).
 */
export interface FleetRunReport {
  worker_id: string;
  attempted: number;
  errored: number;
  remaining_queued: number;
  by_status: Record<string, number>;
  by_esp: Array<{ esp: string; submitted: number; confirmed: number }>;
}

export type FetchLike = typeof fetch;

export class ArchiveError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(message: string, status: number, body: string) {
    super(message);
    this.name = "ArchiveError";
    this.status = status;
    this.body = body;
  }
}

export class ArchiveClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: FetchLike;

  constructor(config: Pick<AgentConfig, "archiveUrl" | "internalApiToken">, fetchImpl?: FetchLike) {
    this.baseUrl = config.archiveUrl.replace(/\/+$/, "");
    this.token = config.internalApiToken;
    // Bind to globalThis so the default isn't an unbound method.
    this.fetchImpl = fetchImpl ?? ((...args) => globalThis.fetch(...args));
  }

  private authHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/json",
      ...extra,
    };
  }

  /**
   * Mint a fresh address for a brand.
   * POST /internal/addresses  body: { brand: { slug, name?, primary_domain?, category? } }
   * → 201 AddressResponse
   */
  async mintAddress(brand: BrandInput, persona?: string): Promise<AddressResponse> {
    const res = await this.fetchImpl(`${this.baseUrl}/internal/addresses`, {
      method: "POST",
      headers: this.authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(persona ? { brand, persona } : { brand }),
    });
    return this.json<AddressResponse>(res, "mintAddress", [201]);
  }

  /**
   * POST /internal/fleet-report — bring back this burst's outcomes before the
   * ephemeral runner store is discarded. A fleet shard's local SQLite store (its
   * funnel, per-ESP breakdown) is thrown away on teardown; without this, the
   * archive only ever learns about emails that arrive, never which stores went
   * submitted vs no_form vs walled. BEST-EFFORT: a failed report must never fail
   * the run — the subscribes already happened — so all errors are swallowed.
   */
  async reportFleetRun(report: FleetRunReport): Promise<void> {
    try {
      await this.fetchImpl(`${this.baseUrl}/internal/fleet-report`, {
        method: "POST",
        headers: this.authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify(report),
      });
    } catch {
      /* best-effort: the run's value is the subscribes, not the report */
    }
  }

  /**
   * GET /internal/subscribed → the set of brand slugs that already have an active
   * or pending_confirm address (already subscribed). Used to skip re-subscribing
   * across ephemeral fleet runs. Defensive: returns an empty set on any failure
   * (incl. an older archive without the endpoint), so seeding proceeds normally.
   */
  async subscribedSlugs(): Promise<Set<string>> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/internal/subscribed`, {
        method: "GET",
        headers: this.authHeaders(),
      });
      if (res.status !== 200) return new Set();
      const body = (await res.json()) as { slugs?: string[] };
      return new Set((body.slugs ?? []).map((s) => s.toLowerCase()));
    } catch {
      return new Set();
    }
  }

  /**
   * Poll the confirmations queue, claiming a batch under `workerId`'s lease.
   * GET /internal/confirmations?status=pending&worker_id=<id>&limit=<n>
   * → 200 ConfirmationResponse[]
   */
  async pollConfirmations(workerId: string, limit = 20): Promise<ConfirmationResponse[]> {
    const url = new URL(`${this.baseUrl}/internal/confirmations`);
    url.searchParams.set("status", "pending");
    url.searchParams.set("worker_id", workerId);
    url.searchParams.set("limit", String(limit));
    const res = await this.fetchImpl(url.toString(), {
      method: "GET",
      headers: this.authHeaders(),
    });
    // The Rails archive returned a bare array; the Cloudflare archive wraps it as
    // { confirmations: [...] }. Accept either so the loop is contract-agnostic.
    const body = await this.json<ConfirmationResponse[] | { confirmations?: ConfirmationResponse[] }>(
      res,
      "pollConfirmations",
      [200],
    );
    return Array.isArray(body) ? body : body?.confirmations ?? [];
  }

  /**
   * Confirm an address after the confirm link was clicked.
   * POST /internal/addresses/:id/confirm → 200 AddressResponse
   */
  async confirmAddress(addressId: number): Promise<AddressResponse> {
    const res = await this.fetchImpl(
      `${this.baseUrl}/internal/addresses/${addressId}/confirm`,
      { method: "POST", headers: this.authHeaders() },
    );
    return this.json<AddressResponse>(res, "confirmAddress", [200]);
  }

  /**
   * Release a claimed confirmation back to pending (couldn't process it).
   * POST /internal/confirmations/:id/release → 200 ConfirmationResponse
   */
  async releaseConfirmation(id: number): Promise<ConfirmationResponse> {
    const res = await this.fetchImpl(
      `${this.baseUrl}/internal/confirmations/${id}/release`,
      { method: "POST", headers: this.authHeaders() },
    );
    return this.json<ConfirmationResponse>(res, "releaseConfirmation", [200]);
  }

  /**
   * Permanently fail a confirmation (e.g. no parseable confirm link).
   * POST /internal/confirmations/:id/fail  body: { note? } → 200 ConfirmationResponse
   */
  async failConfirmation(id: number, note?: string): Promise<ConfirmationResponse> {
    const res = await this.fetchImpl(
      `${this.baseUrl}/internal/confirmations/${id}/fail`,
      {
        method: "POST",
        headers: this.authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify(note === undefined ? {} : { note }),
      },
    );
    return this.json<ConfirmationResponse>(res, "failConfirmation", [200]);
  }

  /**
   * Fetch raw blob bytes (raw .eml) through the archive's blob proxy.
   * GET /internal/blobs/<key> → raw bytes (message/rfc822 for raw_eml/*)
   *
   * Accepts either a bare key (`raw_eml/abc.eml`) or the `raw_eml_url` path the
   * confirmations serializer returns; both resolve to the same endpoint.
   */
  async fetchBlob(keyOrPath: string): Promise<Uint8Array> {
    const path = keyOrPath.startsWith("/internal/blobs/")
      ? keyOrPath
      : `/internal/blobs/${keyOrPath.replace(/^\/+/, "")}`;
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: "GET",
      headers: this.authHeaders({ Accept: "*/*" }),
    });
    if (!res.ok) {
      const body = await safeText(res);
      throw new ArchiveError(`fetchBlob failed (${res.status})`, res.status, body);
    }
    const buf = await res.arrayBuffer();
    return new Uint8Array(buf);
  }

  private async json<T>(res: Response, op: string, okStatuses: number[]): Promise<T> {
    if (!okStatuses.includes(res.status)) {
      const body = await safeText(res);
      throw new ArchiveError(`${op} failed (${res.status})`, res.status, body);
    }
    return (await res.json()) as T;
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}
