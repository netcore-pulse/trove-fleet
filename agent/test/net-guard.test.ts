import { describe, it, expect } from "vitest";
import { isHostBlocked, safeFetchTarget } from "../src/net-guard.ts";

// SSRF guard for the confirm clicker. Uses IP literals + localhost/.local so the
// suite stays hermetic (no real DNS).
describe("net-guard SSRF", () => {
  it("blocks the cloud metadata IP, loopback, RFC1918, link-local v6", async () => {
    for (const h of [
      "169.254.169.254",
      "127.0.0.1",
      "10.0.0.5",
      "192.168.1.1",
      "172.16.0.9",
      "100.64.0.1",
      "0.0.0.0",
      "localhost",
      "foo.local",
      "[::1]",
    ]) {
      expect(await isHostBlocked(h)).toBe(true);
    }
  });

  it("allows public IP literals", async () => {
    expect(await isHostBlocked("8.8.8.8")).toBe(false);
    expect(await isHostBlocked("1.1.1.1")).toBe(false);
  });

  it("safeFetchTarget refuses non-http schemes and private hosts", async () => {
    expect(await safeFetchTarget("file:///etc/passwd")).toBeNull();
    expect(await safeFetchTarget("ftp://8.8.8.8/x")).toBeNull();
    expect(await safeFetchTarget("http://169.254.169.254/latest/meta-data/")).toBeNull();
    expect(await safeFetchTarget("http://127.0.0.1:6379/")).toBeNull();
    const ok = await safeFetchTarget("https://8.8.8.8/confirm?token=x");
    expect(ok).not.toBeNull();
    expect(ok?.protocol).toBe("https:");
  });
});
