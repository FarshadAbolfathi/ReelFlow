"""Runs the SSRF vectors shared with the TypeScript implementation."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from reelflow_network import UrlBlockedError, assert_public_destination, normalize_url, validate_public_url

VECTORS = json.loads((Path(__file__).resolve().parents[3] / "tests" / "fixtures" / "ssrf-vectors.json").read_text())


@pytest.mark.parametrize("v", VECTORS["urls"], ids=lambda v: v["url"])
def test_url_vectors(v):
    if v["blocked"]:
        with pytest.raises(UrlBlockedError):
            validate_public_url(v["url"])
    else:
        assert validate_public_url(v["url"])


@pytest.mark.parametrize("v", VECTORS["resolved"], ids=lambda v: ",".join(v["addresses"]))
def test_resolved_vectors(v):
    resolver = lambda _host: v["addresses"]  # noqa: E731
    if v["blocked"]:
        with pytest.raises(UrlBlockedError):
            assert_public_destination(f"https://{v['host']}/", resolver)
    else:
        assert assert_public_destination(f"https://{v['host']}/", resolver) == v["addresses"]


@pytest.mark.parametrize("v", VECTORS["normalize"], ids=lambda v: v["in"])
def test_normalize_vectors(v):
    assert normalize_url(v["in"]) == v["out"]
    assert normalize_url(normalize_url(v["in"])) == v["out"]
