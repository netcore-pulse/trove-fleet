import { describe, it, expect } from "vitest";
import {
  canonicalizeDomain,
  parseSeedText,
  brandSlugFromDomain,
} from "../src/canonical.ts";

describe("canonicalizeDomain — registrable-domain collapse", () => {
  it("collapses www / path / scheme / case to the same registrable domain", () => {
    const variants = [
      "nike.com",
      "www.nike.com",
      "WWW.NIKE.COM",
      "https://www.nike.com/uk",
      "http://nike.com/uk/",
      "https://NIKE.com/en?ref=foo#frag",
      "shop.nike.com",
      "store.eu.nike.com",
    ];
    const canon = variants.map(canonicalizeDomain);
    for (const c of canon) expect(c).toBe("nike.com");
  });

  it("honors multi-part public suffixes (co.uk)", () => {
    expect(canonicalizeDomain("shop.example.co.uk")).toBe("example.co.uk");
    expect(canonicalizeDomain("www.example.co.uk")).toBe("example.co.uk");
  });

  it("returns null for inputs with no registrable domain", () => {
    expect(canonicalizeDomain("")).toBeNull();
    expect(canonicalizeDomain("   ")).toBeNull();
    expect(canonicalizeDomain("localhost")).toBeNull();
    expect(canonicalizeDomain("127.0.0.1")).toBeNull();
    expect(canonicalizeDomain("http://192.168.0.1/x")).toBeNull();
  });
});

describe("parseSeedText", () => {
  it("parses newline + CSV rows, skips blanks/comments/header", () => {
    const text = [
      "domain,brand_name,category",
      "# a comment",
      "",
      "nike.com,Nike,Apparel",
      "  adidas.com , Adidas ,  Footwear ",
      "baredomain.com",
      '"quoted.com","Quoted Brand","Cat"',
    ].join("\n");
    const rows = parseSeedText(text);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toEqual({ domain: "nike.com", brand_name: "Nike", category: "Apparel" });
    expect(rows[1]).toEqual({ domain: "adidas.com", brand_name: "Adidas", category: "Footwear" });
    expect(rows[2]).toEqual({ domain: "baredomain.com", brand_name: undefined, category: undefined });
    expect(rows[3]).toEqual({ domain: "quoted.com", brand_name: "Quoted Brand", category: "Cat" });
  });
});

describe("brandSlugFromDomain", () => {
  it("derives the leftmost label", () => {
    expect(brandSlugFromDomain("nike.com")).toBe("nike");
    expect(brandSlugFromDomain("example.co.uk")).toBe("example");
  });
});
