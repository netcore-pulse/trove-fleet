import { describe, it, expect } from "vitest";
import { ArchiveClient, ArchiveError, type FetchLike } from "../src/archive-client.ts";

const CONFIG = { archiveUrl: "http://localhost:3033", internalApiToken: "test-token" };

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

/**
 * Build a stub `fetch` that records the request and returns a canned Response.
 * Stubs strictly at the HTTP boundary — no live archive.
 */
function stubFetch(
  responder: (req: Captured) => { status: number; body: unknown; bytes?: Uint8Array },
): { fetch: FetchLike; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(init?.headers ?? {})) headers[k] = String(v);
    const captured: Captured = {
      url,
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? init.body : undefined,
    };
    calls.push(captured);
    const { status, body, bytes } = responder(captured);
    if (bytes) {
      return new Response(bytes, { status });
    }
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as FetchLike;
  return { fetch: fetchImpl, calls };
}

const ADDRESS_RESPONSE = {
  id: 7,
  address: "nike.a1b2c3@in.trove.dev",
  status: "pending_confirm",
  brand_id: 3,
  brand_slug: "nike",
  minted_at: "2026-06-23T10:00:00Z",
  confirm_deadline: "2026-06-30T10:00:00Z",
  confirmed_at: null,
};

describe("ArchiveClient.mintAddress — POST /internal/addresses", () => {
  it("sends { brand: {...} }, Bearer auth, and parses the 201 address", async () => {
    const { fetch, calls } = stubFetch(() => ({ status: 201, body: ADDRESS_RESPONSE }));
    const client = new ArchiveClient(CONFIG, fetch);

    const addr = await client.mintAddress({
      slug: "nike",
      name: "Nike",
      primary_domain: "nike.com",
      category: "Apparel",
    });

    expect(addr).toEqual(ADDRESS_RESPONSE);
    expect(calls).toHaveLength(1);
    const c = calls[0]!;
    expect(c.method).toBe("POST");
    expect(c.url).toBe("http://localhost:3033/internal/addresses");
    expect(c.headers.Authorization).toBe("Bearer test-token");
    expect(c.headers["Content-Type"]).toBe("application/json");
    // Body matches the frozen contract: a top-level `brand` object.
    expect(JSON.parse(c.body!)).toEqual({
      brand: { slug: "nike", name: "Nike", primary_domain: "nike.com", category: "Apparel" },
    });
  });

  it("throws ArchiveError on a non-201", async () => {
    const { fetch } = stubFetch(() => ({ status: 401, body: { error: "unauthorized" } }));
    const client = new ArchiveClient(CONFIG, fetch);
    await expect(client.mintAddress({ slug: "x" })).rejects.toBeInstanceOf(ArchiveError);
  });
});

describe("ArchiveClient.pollConfirmations — GET /internal/confirmations", () => {
  it("builds the documented query string and returns the array", async () => {
    const confirmation = {
      id: 11,
      status: "claimed",
      address: { id: 7, address: "nike.a1@in.trove.dev", brand_slug: "nike", status: "pending_confirm" },
      raw_eml_key: "raw_eml/abc.eml",
      claimed_by: "agent-1",
      claimed_at: "2026-06-23T10:01:00Z",
      created_at: "2026-06-23T10:00:30Z",
      raw_eml_url: "/internal/blobs/raw_eml/abc.eml",
    };
    const { fetch, calls } = stubFetch(() => ({ status: 200, body: [confirmation] }));
    const client = new ArchiveClient(CONFIG, fetch);

    const out = await client.pollConfirmations("agent-1", 50);
    expect(out).toEqual([confirmation]);

    const u = new URL(calls[0]!.url);
    expect(u.pathname).toBe("/internal/confirmations");
    expect(u.searchParams.get("status")).toBe("pending");
    expect(u.searchParams.get("worker_id")).toBe("agent-1");
    expect(u.searchParams.get("limit")).toBe("50");
    expect(calls[0]!.headers.Authorization).toBe("Bearer test-token");
  });
});

describe("ArchiveClient.confirmAddress — POST /internal/addresses/:id/confirm", () => {
  it("posts to the id-scoped confirm path", async () => {
    const { fetch, calls } = stubFetch(() => ({
      status: 200,
      body: { ...ADDRESS_RESPONSE, status: "active", confirmed_at: "2026-06-23T10:05:00Z" },
    }));
    const client = new ArchiveClient(CONFIG, fetch);
    const addr = await client.confirmAddress(7);
    expect(addr.status).toBe("active");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe("http://localhost:3033/internal/addresses/7/confirm");
  });
});

describe("ArchiveClient.release/fail confirmation", () => {
  it("release posts to the release path", async () => {
    const { fetch, calls } = stubFetch((req) => ({
      status: 200,
      body: { id: 11, status: "pending", address: {}, raw_eml_key: null, claimed_by: null, claimed_at: null, created_at: "", raw_eml_url: null },
    }));
    const client = new ArchiveClient(CONFIG, fetch);
    await client.releaseConfirmation(11);
    expect(calls[0]!.url).toBe("http://localhost:3033/internal/confirmations/11/release");
    expect(calls[0]!.method).toBe("POST");
  });

  it("fail posts a { note } body when provided", async () => {
    const { fetch, calls } = stubFetch(() => ({
      status: 200,
      body: { id: 11, status: "failed", address: {}, raw_eml_key: null, claimed_by: null, claimed_at: null, created_at: "", raw_eml_url: null },
    }));
    const client = new ArchiveClient(CONFIG, fetch);
    await client.failConfirmation(11, "no confirm link");
    expect(calls[0]!.url).toBe("http://localhost:3033/internal/confirmations/11/fail");
    expect(JSON.parse(calls[0]!.body!)).toEqual({ note: "no confirm link" });
  });
});

describe("ArchiveClient.fetchBlob — GET /internal/blobs/<key>", () => {
  it("fetches raw bytes by bare key", async () => {
    const bytes = new TextEncoder().encode("From: brand\r\nSubject: confirm\r\n\r\nhi");
    const { fetch, calls } = stubFetch(() => ({ status: 200, body: null, bytes }));
    const client = new ArchiveClient(CONFIG, fetch);

    const out = await client.fetchBlob("raw_eml/abc.eml");
    expect(out).toEqual(bytes);
    expect(calls[0]!.url).toBe("http://localhost:3033/internal/blobs/raw_eml/abc.eml");
  });

  it("accepts the raw_eml_url path form from the confirmations serializer", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const { fetch, calls } = stubFetch(() => ({ status: 200, body: null, bytes }));
    const client = new ArchiveClient(CONFIG, fetch);
    await client.fetchBlob("/internal/blobs/raw_eml/abc.eml");
    expect(calls[0]!.url).toBe("http://localhost:3033/internal/blobs/raw_eml/abc.eml");
  });

  it("throws ArchiveError on a 404", async () => {
    const { fetch } = stubFetch(() => ({ status: 404, body: { error: "not_found" } }));
    const client = new ArchiveClient(CONFIG, fetch);
    await expect(client.fetchBlob("raw_eml/missing.eml")).rejects.toBeInstanceOf(ArchiveError);
  });
});

describe("ArchiveClient — base URL handling", () => {
  it("strips a trailing slash from the configured base URL", async () => {
    const { fetch, calls } = stubFetch(() => ({ status: 201, body: ADDRESS_RESPONSE }));
    const client = new ArchiveClient({ ...CONFIG, archiveUrl: "http://localhost:3033/" }, fetch);
    await client.mintAddress({ slug: "nike" });
    expect(calls[0]!.url).toBe("http://localhost:3033/internal/addresses");
  });
});
