import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertPublicDestination, isBlockedIp, normalizeUrl, validatePublicUrl } from "../src/url";

const vectors = JSON.parse(
  readFileSync(path.resolve(import.meta.dirname, "../../../tests/fixtures/ssrf-vectors.json"), "utf8"),
) as {
  urls: { url: string; blocked: boolean }[];
  resolved: { host: string; addresses: string[]; blocked: boolean }[];
  normalize: { in: string; out: string }[];
};

describe("validatePublicUrl (SSRF, pre-DNS)", () => {
  for (const v of vectors.urls) {
    it(`${v.blocked ? "blocks" : "allows"} ${v.url}`, () => {
      if (v.blocked) expect(() => validatePublicUrl(v.url)).toThrow();
      else expect(validatePublicUrl(v.url)).toBeInstanceOf(URL);
    });
  }

  it("uses the URL_BLOCKED error code", () => {
    try {
      validatePublicUrl("http://127.0.0.1/");
    } catch (e) {
      expect((e as { code: string }).code).toBe("URL_BLOCKED");
    }
  });
});

describe("assertPublicDestination (post-DNS, rebinding-safe)", () => {
  for (const v of vectors.resolved) {
    it(`${v.blocked ? "blocks" : "allows"} ${v.host} → ${v.addresses.join(",")}`, async () => {
      const resolver = async () => v.addresses;
      const p = assertPublicDestination(new URL(`https://${v.host}/`), resolver);
      if (v.blocked) await expect(p).rejects.toMatchObject({ code: "URL_BLOCKED" });
      else await expect(p).resolves.toEqual(v.addresses);
    });
  }

  it("fails with SOURCE_UNAVAILABLE when DNS fails", async () => {
    const resolver = async () => {
      throw new Error("ENOTFOUND");
    };
    await expect(assertPublicDestination(new URL("https://nope.example/"), resolver)).rejects.toMatchObject({
      code: "SOURCE_UNAVAILABLE",
    });
  });
});

describe("isBlockedIp", () => {
  it("blocks metadata and private ranges", () => {
    for (const ip of ["169.254.169.254", "10.1.2.3", "192.168.0.1", "::1", "fc00::1"]) expect(isBlockedIp(ip)).toBe(true);
  });
  it("allows public unicast", () => {
    expect(isBlockedIp("8.8.8.8")).toBe(false);
  });
  it("treats garbage as blocked", () => {
    expect(isBlockedIp("not-an-ip")).toBe(true);
  });
});

describe("normalizeUrl (duplicate detection layer 1)", () => {
  for (const v of vectors.normalize) {
    it(`${v.in} → ${v.out}`, () => expect(normalizeUrl(v.in)).toBe(v.out));
  }
  it("is idempotent", () => {
    for (const v of vectors.normalize) expect(normalizeUrl(normalizeUrl(v.in))).toBe(v.out);
  });
});
