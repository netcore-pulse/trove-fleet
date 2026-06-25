/**
 * Production attempt step (A3) — bridges the bounded pool's {@link AttemptStep}
 * to A1's real subscribe loop (`subscribeOnPage`), wiring in the leased proxy +
 * the persona fingerprint.
 *
 * This is the seam where A3's footprint controls meet A1's per-target logic:
 *   - the leased PROXY is passed to a per-attempt {@link BrowserWorker} so each
 *     attempt egresses through a (potentially) different IP — the one-liner the
 *     A1 worker documented as the A3 slot-in point;
 *   - the persona-derived FINGERPRINT (viewport/UA/locale/tz) already varies per
 *     target inside the worker;
 *   - A1's `subscribeOnPage` does the actual find-form → mint → fill → submit →
 *     classify, returning a status the pool persists.
 *
 * It is NOT exercised by the offline test suite (it drives real chromium + a
 * real archive). The pool's orchestration is proven against a fake step; A1's
 * loop is proven against fixtures. This file is the thin, typed glue between them
 * — kept minimal so there's little to get wrong.
 */

import { BrowserWorker } from "../browser/worker.ts";
import { subscribeOnPage, type MintFn } from "../subscribe.ts";
import type { AttemptStep, AttemptResult } from "./pool.ts";

export interface SubscribeStepOptions {
  /** Mint boundary (ArchiveClient.mintAddress in prod). */
  mint: MintFn;
  /** Resolve a domain to its URL. Defaults to https://<domain>/. */
  urlForDomain?: (domain: string) => string;
  /** Run chromium headless (default true). */
  headless?: boolean;
}

/**
 * Build the production attempt step. Each call leases a fresh browser bound to
 * the attempt's proxy, runs the A1 loop, and tears the browser down — so a dead
 * proxy or a hung page can never leak into the next attempt.
 */
export function makeSubscribeStep(opts: SubscribeStepOptions): AttemptStep {
  const urlFor = opts.urlForDomain ?? ((d: string) => `https://${d}/`);
  const headless = opts.headless ?? true;

  return async (ctx): Promise<AttemptResult> => {
    // Bind the leased proxy to this attempt's chromium. server===null = direct.
    const worker = new BrowserWorker({
      headless,
      proxyServer: ctx.proxy.server,
    });

    try {
      const { page } = await worker.openPage(urlFor(ctx.domain), ctx.persona);
      try {
        const result = await subscribeOnPage(page, {
          mint: opts.mint,
          persona: ctx.persona,
          domain: ctx.domain,
          brandName: ctx.row.brand_name ?? undefined,
          category: ctx.row.category ?? undefined,
        });
        return {
          status: result.status,
          reason: result.reason,
          address: result.address,
          addressId: result.addressId,
          esp: result.esp,
          // A page that loaded + classified means the egress worked, even on a
          // block/no-form. Only an exception (caught below) is a proxy miss.
          proxyOk: true,
        };
      } finally {
        await worker.closePage(page);
      }
    } finally {
      await worker.close();
    }
  };
}
