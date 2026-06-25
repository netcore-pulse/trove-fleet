# trove-fleet

The **subscribe fleet** for [Trove](https://github.com/netcore-pulse/trove) — run on
GitHub Actions so each shard executes on a separate runner (a distinct egress IP),
parallelising newsletter subscription across the verified-Shopify seed list.

- **`agent/`** — the Trove Subscriber Agent (Node/TS + Playwright). Drives a headless
  browser to find a brand's newsletter signup, mints a synthetic address against the
  Trove archive, fills + submits, and (separately) clicks only double-opt-in confirm links.
- **`seed/shopify-seed.csv`** — the verified live-Shopify storefronts to subscribe to
  (`domain,url,brand_name,category,esp,source`).
- **`.github/workflows/subscribe.yml`** — the sharded fleet.

## How it runs

`subscribe.yml` is **workflow_dispatch only** (Actions → "subscribe" → Run workflow):

- **shards** — how many parallel runners (= concurrent egress IPs). Each takes a
  disjoint `NR % shards == shard` slice of the seed.
- **limit** — max targets per shard this run.
- **offset** — skip the first N seed domains, to page through the list across runs.

Each shard: `npm ci` → install Playwright Chromium → seed its slice → `agent burst`.
A final `confirm` job clicks any double-opt-in links. Minted addresses report to the
shared archive (dedup by recipient), so shards compose without double-subscribing.

## Config (one-time)

- **Variable** `TROVE_ARCHIVE_URL` — the archive base URL.
- **Secret** `TROVE_INTERNAL_API_TOKEN` — the archive internal API token.

Both are read by the agent at runtime. The workflow is owner-triggered only, so the
secret is never exposed to forks or pull requests.

## Notes

- Runner IPs are **datacenter** IPs — fine for the easy-picking majority (footer /
  Klaviyo signups). Stores behind hard bot detection (Cloudflare/DataDome) are
  detected once and **skipped** (`needs_solver`), never fought.
- The burst is **throttled and resumable**; re-running pages further with `offset`.
- Cardinal rules are baked into the agent: synthetic personas only, click only the
  confirm link, never double-subscribe, never fight a CAPTCHA.
