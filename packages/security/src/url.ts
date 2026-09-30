/**
 * URL validation, normalization and SSRF protection.
 * The Python engine implements the same rules (reelflow_network/ssrf.py);
 * both are tested against tests/fixtures/ssrf-vectors.json.
 */
import { lookup } from "node:dns/promises";
import ipaddr from "ipaddr.js";
import { AppError } from "@reelflow/types";

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

/** Hostnames that are never fetched regardless of what they resolve to. */
const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
  "metadata",
  "metadata.google.internal",
  "metadata.goog",
  "instance-data",
  "instance-data.ec2.internal",
]);
const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".intranet", ".lan", ".home", ".corp", ".home.arpa"];

/** ipaddr.js range names that are not public unicast. */
const BLOCKED_RANGES = new Set([
  "unspecified",
  "broadcast",
  "multicast",
  "linkLocal",
  "loopback",
  "carrierGradeNat",
  "private",
  "reserved",
  "uniqueLocal",
  "ipv4Mapped",
  "rfc6145",
  "rfc6052",
  "6to4",
  "teredo",
  "benchmarking",
  "amt",
  "as112",
  "as112v6",
  "orchid2",
  "droneRemoteIdProtocolEntityTags",
  "discard",
]);

export function isBlockedIp(ip: string): boolean {
  if (!ipaddr.isValid(ip)) return true;
  let addr = ipaddr.parse(ip);
  if (addr.kind() === "ipv6" && (addr as ipaddr.IPv6).isIPv4MappedAddress()) {
    addr = (addr as ipaddr.IPv6).toIPv4Address();
  }
  const range = addr.range();
  if (BLOCKED_RANGES.has(range)) return true;
  // Explicitly block IPv4 "this network" and documentation ranges that some versions label "unicast".
  if (addr.kind() === "ipv4") {
    const v4 = addr as ipaddr.IPv4;
    const cidrs: [string, number][] = [
      ["0.0.0.0", 8],
      ["192.0.0.0", 24],
      ["192.0.2.0", 24],
      ["198.18.0.0", 15],
      ["198.51.100.0", 24],
      ["203.0.113.0", 24],
      ["240.0.0.0", 4],
      ["100.64.0.0", 10],
      ["169.254.0.0", 16],
    ];
    if (cidrs.some(([net, bits]) => v4.match(ipaddr.IPv4.parse(net), bits))) return true;
  }
  return range !== "unicast";
}

export function isBlockedHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  if (h.length === 0) return true;
  if (BLOCKED_HOSTNAMES.has(h)) return true;
  if (BLOCKED_SUFFIXES.some((s) => h.endsWith(s))) return true;
  // Single-label names ("intranet", "router") are internal by definition.
  if (!h.includes(".") && !ipaddr.isValid(h)) return true;
  return false;
}

/** Strip brackets from IPv6 literals. */
const bareHost = (hostname: string) => hostname.replace(/^\[|\]$/g, "");

/**
 * Parses a user-supplied URL and rejects anything that is not a public http(s) URL.
 * Does NOT resolve DNS — use `assertPublicDestination` before actually connecting.
 */
export function validatePublicUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new AppError("URL_BLOCKED", "Not a valid URL");
  }
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) throw new AppError("URL_BLOCKED", "Only http and https URLs are allowed");
  if (url.username || url.password) throw new AppError("URL_BLOCKED", "URLs with embedded credentials are not allowed");
  const host = bareHost(url.hostname);
  if (ipaddr.isValid(host)) {
    if (isBlockedIp(host)) throw new AppError("URL_BLOCKED", "Destination address is not a public address");
  } else if (!/^[a-z0-9.-]+$/i.test(host) || isBlockedHostname(host)) {
    throw new AppError("URL_BLOCKED", "Destination host is internal or invalid");
  }
  if (url.port && !["80", "443", "8080", "8443"].includes(url.port)) {
    throw new AppError("URL_BLOCKED", `Port ${url.port} is not allowed`);
  }
  return url;
}

export type Resolver = (hostname: string) => Promise<string[]>;

const defaultResolver: Resolver = async (hostname) =>
  (await lookup(hostname, { all: true, verbatim: true })).map((r) => r.address);

/**
 * Resolves the host and verifies every resolved address is public.
 * Returns the addresses so callers can pin the connection to a vetted IP
 * (prevents DNS-rebinding between check and connect).
 */
export async function assertPublicDestination(url: URL, resolver: Resolver = defaultResolver): Promise<string[]> {
  const host = bareHost(url.hostname);
  if (ipaddr.isValid(host)) {
    if (isBlockedIp(host)) throw new AppError("URL_BLOCKED", "Destination address is not public");
    return [host];
  }
  let addrs: string[];
  try {
    addrs = await resolver(host);
  } catch (e) {
    throw new AppError("SOURCE_UNAVAILABLE", `DNS lookup failed for ${host}`, { cause: e });
  }
  if (addrs.length === 0) throw new AppError("SOURCE_UNAVAILABLE", `No addresses for ${host}`);
  const blocked = addrs.filter(isBlockedIp);
  if (blocked.length > 0) {
    throw new AppError("URL_BLOCKED", `Host ${host} resolves to a non-public address`, { details: { blocked } });
  }
  return addrs;
}

const TRACKING_PARAMS = [/^utm_/i, /^fbclid$/i, /^gclid$/i, /^igshid$/i, /^igsh$/i, /^mc_[a-z]+$/i, /^ref$/i, /^ref_src$/i, /^si$/i];

/**
 * Canonical form used for duplicate detection (layer 1):
 * lowercase scheme/host, no default port, no fragment, no tracking params,
 * sorted query, no trailing slash, instagram `/reels/` → `/reel/`.
 */
export function normalizeUrl(raw: string): string {
  const url = new URL(raw.trim());
  url.hash = "";
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, "").replace(/^m\./, "");
  if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) url.port = "";
  url.protocol = "https:";
  const kept = [...url.searchParams.entries()]
    .filter(([k]) => !TRACKING_PARAMS.some((re) => re.test(k)))
    .sort(([a], [b]) => a.localeCompare(b));
  url.search = "";
  for (const [k, v] of kept) url.searchParams.append(k, v);
  let pathname = url.pathname.replace(/\/{2,}/g, "/");
  if (url.hostname === "instagram.com") pathname = pathname.replace(/^\/reels\//, "/reel/");
  if (pathname.length > 1) pathname = pathname.replace(/\/+$/, "");
  url.pathname = pathname;
  return url.toString();
}
