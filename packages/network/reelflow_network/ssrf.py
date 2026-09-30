"""SSRF protection. Same rules as packages/security/src/url.ts; both are tested
against tests/fixtures/ssrf-vectors.json."""

from __future__ import annotations

import ipaddress
import socket
from collections.abc import Callable, Iterable
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit


class UrlBlockedError(ValueError):
    code = "URL_BLOCKED"


BLOCKED_HOSTNAMES = {
    "localhost",
    "localhost.localdomain",
    "ip6-localhost",
    "ip6-loopback",
    "metadata",
    "metadata.google.internal",
    "metadata.goog",
    "instance-data",
    "instance-data.ec2.internal",
}
BLOCKED_SUFFIXES = (".localhost", ".local", ".internal", ".intranet", ".lan", ".home", ".corp", ".home.arpa")
ALLOWED_PORTS = {None, 80, 443, 8080, 8443}
_EXTRA_BLOCKED = [ipaddress.ip_network(n) for n in ("100.64.0.0/10", "198.18.0.0/15", "192.0.0.0/24", "0.0.0.0/8", "240.0.0.0/4")]


def _parse_ip_loose(host: str) -> ipaddress.IPv4Address | ipaddress.IPv6Address | None:
    """Parses dotted, integer (2130706433), hex (0x7f000001) and short (127.1) IPv4 forms."""
    try:
        return ipaddress.ip_address(host)
    except ValueError:
        pass
    try:
        # inet_aton accepts all the legacy IPv4 notations browsers/curl accept.
        return ipaddress.IPv4Address(socket.inet_aton(host))
    except OSError:
        return None


def is_blocked_ip(ip: ipaddress.IPv4Address | ipaddress.IPv6Address | str) -> bool:
    if isinstance(ip, str):
        parsed = _parse_ip_loose(ip)
        if parsed is None:
            return True
        ip = parsed
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped:
        ip = ip.ipv4_mapped
    if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_reserved or ip.is_unspecified:
        return True
    if isinstance(ip, ipaddress.IPv6Address) and (ip.sixtofour or ip.teredo or ip in ipaddress.ip_network("fc00::/7")):
        return True
    if isinstance(ip, ipaddress.IPv4Address) and any(ip in n for n in _EXTRA_BLOCKED):
        return True
    return not ip.is_global


def is_blocked_hostname(host: str) -> bool:
    h = host.lower().rstrip(".")
    if not h or h in BLOCKED_HOSTNAMES or h.endswith(BLOCKED_SUFFIXES):
        return True
    return "." not in h and _parse_ip_loose(h) is None


def validate_public_url(raw: str) -> str:
    """Rejects anything that is not a public http(s) URL. Does not resolve DNS."""
    try:
        parts = urlsplit(raw.strip())
        port = parts.port
    except ValueError as e:
        raise UrlBlockedError("Not a valid URL") from e
    if parts.scheme not in ("http", "https"):
        raise UrlBlockedError("Only http and https URLs are allowed")
    if parts.username or parts.password:
        raise UrlBlockedError("URLs with embedded credentials are not allowed")
    host = (parts.hostname or "").strip("[]")
    ip = _parse_ip_loose(host)
    if ip is not None:
        if is_blocked_ip(ip):
            raise UrlBlockedError("Destination address is not a public address")
    elif not host or any(c not in "abcdefghijklmnopqrstuvwxyz0123456789.-" for c in host.lower()) or is_blocked_hostname(host):
        raise UrlBlockedError("Destination host is internal or invalid")
    if port not in ALLOWED_PORTS:
        raise UrlBlockedError(f"Port {port} is not allowed")
    return raw.strip()


Resolver = Callable[[str], Iterable[str]]


def _default_resolver(host: str) -> list[str]:
    return list({ai[4][0] for ai in socket.getaddrinfo(host, None)})


def assert_public_destination(url: str, resolver: Resolver = _default_resolver) -> list[str]:
    """DIRECT mode: resolves and ensures every address is public (anti DNS-rebinding)."""
    host = (urlsplit(url).hostname or "").strip("[]")
    ip = _parse_ip_loose(host)
    if ip is not None:
        if is_blocked_ip(ip):
            raise UrlBlockedError("Destination address is not public")
        return [str(ip)]
    addrs = list(resolver(host))
    if not addrs:
        raise UrlBlockedError(f"No addresses for {host}")
    bad = [a for a in addrs if is_blocked_ip(a)]
    if bad:
        raise UrlBlockedError(f"Host {host} resolves to a non-public address")
    return addrs


_TRACKING = ("utm_", "fbclid", "gclid", "igshid", "igsh", "mc_", "ref", "ref_src", "si")


def normalize_url(raw: str) -> str:
    """Canonical URL for duplicate detection (layer 1). Matches normalizeUrl in TS."""
    p = urlsplit(raw.strip())
    host = (p.hostname or "").lower()
    for prefix in ("www.", "m."):
        if host.startswith(prefix):
            host = host[len(prefix) :]
    port = p.port
    netloc = host if port in (None, 80, 443) else f"{host}:{port}"
    q = sorted(
        (k, v)
        for k, v in parse_qsl(p.query, keep_blank_values=True)
        if not any(k.lower() == t or (t.endswith("_") and k.lower().startswith(t)) for t in _TRACKING)
    )
    path = "/".join(seg for seg in p.path.split("/")) if p.path else "/"
    while "//" in path:
        path = path.replace("//", "/")
    if host == "instagram.com" and path.startswith("/reels/"):
        path = "/reel/" + path[len("/reels/") :]
    if len(path) > 1:
        path = path.rstrip("/") or "/"
    return urlunsplit(("https", netloc, path or "/", urlencode(q), ""))
