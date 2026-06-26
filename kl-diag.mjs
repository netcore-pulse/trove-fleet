// Read-only: does Klaviyo populate its onsite form registry from THIS (GHA datacenter)
// IP? Loads Klaviyo storefronts headless, polls 15s, prints when (if ever) the registry
// fills and whether openForm yields a fillable input. No subscribing.
import pw from "./agent/node_modules/playwright-core/index.js";
const { chromium } = pw;
const URLS = ["https://slamgoods.com/", "https://3sixteen.com/", "https://2pood.com/", "https://1620usa.com/"];

const probe = `async () => {
  const out = { timeline: [] };
  const w = window;
  const snap = () => {
    let ls = [];
    try { ls = Object.keys((JSON.parse(localStorage.getItem('klaviyoOnsite')||'{}').viewedForms?.modal?.viewedForms)||{}); } catch(e){}
    return { t: Math.round(performance.now()), klReady: typeof w.klaviyo?.openForm==='function',
      hasScript: !!document.querySelector('script[src*="static.klaviyo.com/onsite"]'), lsN:[...new Set(ls)].length, ids:[...new Set(ls)] };
  };
  for (let i=0;i<30;i++){ out.timeline.push(snap()); await new Promise(r=>setTimeout(r,500)); }
  const last = out.timeline.at(-1);
  try { for (const id of last.ids) w.klaviyo?.openForm?.(id); } catch(e){}
  await new Promise(r=>setTimeout(r,2500));
  out.fillable = [...document.querySelectorAll('input[type=email],input[name*="email" i]')].filter(e=>e.offsetParent!==null).length;
  return out;
}`;

const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
for (const url of URLS) {
  const ctx = await browser.newContext({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36" });
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: "load", timeout: 30000 });
    const r = await page.evaluate(eval(probe));
    const ready = r.timeline.find(x => x.lsN > 0);
    const scriptSeen = r.timeline.some(x => x.hasScript);
    console.log(`${url}  scriptLoaded=${scriptSeen}  registry=${ready ? ready.t+"ms "+JSON.stringify(ready.ids) : "NEVER/15s"}  fillableAfterOpen=${r.fillable}`);
  } catch (e) { console.log(`${url}  ERROR ${String(e).slice(0,90)}`); }
  finally { await ctx.close(); }
}
await browser.close();
