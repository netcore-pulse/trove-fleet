#!/usr/bin/env node
// MIRRORED from netcore-pulse/trove → cf-archive/scripts/precompute-embeddings.mjs (source of
// truth). Lives here too so the hourly embed job runs on this PUBLIC repo's free/unlimited
// Actions minutes instead of the private trove repo's metered 2,000-min quota. Keep in sync if
// the internal embed-queue / embeddings contract changes.
// Precompute semantic-search vectors for the archive corpus.
//
// Runs in Node (CI / local), NOT in the Worker: the inbound email() handler can't
// run MiniLM, and Workers AI is a different model that wouldn't match the browser's
// query embeddings. This uses the SAME model the browser loads for the query
// (Xenova/all-MiniLM-L6-v2, quantized) so cosine similarity is meaningful.
//
// Loop: GET /internal/embed-queue (rows with NULL embedding + the text to embed)
//   → embed with MiniLM → int8-quantize → POST /internal/embeddings. Idempotent:
// only ever touches un-embedded rows, so re-runs are cheap and pick up new arrivals.
//
//   TROVE_INTERNAL_API_TOKEN=<token> \
//   ARCHIVE_URL=https://trove.livingemails.com \
//     node scripts/precompute-embeddings.mjs

import { pipeline, env } from '@xenova/transformers';

const ARCHIVE_URL = (process.env.ARCHIVE_URL || 'https://trove.livingemails.com').replace(/\/+$/, '');
const TOKEN = process.env.TROVE_INTERNAL_API_TOKEN;
const BATCH = parseInt(process.env.BATCH || '200', 10);
const MODEL = 'Xenova/all-MiniLM-L6-v2';

if (!TOKEN) { console.error('TROVE_INTERNAL_API_TOKEN is required'); process.exit(1); }

env.allowLocalModels = false; // pull the model from the Hub

const auth = { Authorization: `Bearer ${TOKEN}` };

// unit-normalized float vector → int8 (×127, clamped), stored as unsigned bytes
// (two's complement) → base64. The client sign-extends + renormalizes on decode.
function quantToB64(f32) {
  const n = f32.length, b = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    let q = Math.round(f32[i] * 127);
    if (q > 127) q = 127; else if (q < -127) q = -127;
    b[i] = q & 0xff;
  }
  return Buffer.from(b).toString('base64');
}

async function main() {
  console.log(`[precompute] model=${MODEL} archive=${ARCHIVE_URL} batch=${BATCH}`);
  const extract = await pipeline('feature-extraction', MODEL, { quantized: true });
  let written = 0, round = 0;
  for (;;) {
    const res = await fetch(`${ARCHIVE_URL}/internal/embed-queue?limit=${BATCH}`, { headers: auth });
    if (!res.ok) throw new Error(`embed-queue ${res.status}: ${await res.text()}`);
    const { items, remaining } = await res.json();
    if (!items || !items.length) { console.log(`[precompute] queue empty (remaining=${remaining ?? 0})`); break; }
    round++;
    const vectors = [];
    for (const it of items) {
      const out = await extract(it.t || ' ', { pooling: 'mean', normalize: true });
      vectors.push({ id: it.id, v: quantToB64(out.data) });
    }
    const post = await fetch(`${ARCHIVE_URL}/internal/embeddings`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ vectors }),
    });
    if (!post.ok) throw new Error(`embeddings POST ${post.status}: ${await post.text()}`);
    const j = await post.json();
    written += j.updated || 0;
    console.log(`[precompute] round ${round}: embedded ${items.length}, updated ${j.updated}, ~remaining ${Math.max(0, (remaining || items.length) - items.length)}`);
  }
  console.log(`[precompute] done — ${written} vectors written`);
}

main().catch((e) => { console.error('[precompute] FAILED:', e); process.exit(1); });
