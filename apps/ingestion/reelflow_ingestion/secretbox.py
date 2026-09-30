"""AES-256-GCM secrets at rest — byte-compatible with packages/security/src/crypto.ts.

Format: v1.<iv b64url>.<tag b64url>.<ciphertext b64url>, AAD bound to the row
(e.g. "account:<uuid>") so a ciphertext cannot be moved to another account.
"""

from __future__ import annotations

import base64
import os

from Cryptodome.Cipher import AES

VERSION = "v1"


def _b64e(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def _b64d(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def load_key(raw: str) -> bytes:
    key = base64.b64decode(raw)
    if len(key) != 32:
        raise ValueError("ENCRYPTION_KEY must decode to exactly 32 bytes")
    return key


def encrypt_secret(plaintext: str, key: bytes, aad: str = "reelflow") -> str:
    iv = os.urandom(12)
    cipher = AES.new(key, AES.MODE_GCM, nonce=iv)
    cipher.update(aad.encode())
    ct, tag = cipher.encrypt_and_digest(plaintext.encode())
    return ".".join([VERSION, _b64e(iv), _b64e(tag), _b64e(ct)])


def decrypt_secret(payload: str, key: bytes, aad: str = "reelflow") -> str:
    parts = payload.split(".")
    if len(parts) != 4 or parts[0] != VERSION:
        raise ValueError("Unsupported secret format")
    cipher = AES.new(key, AES.MODE_GCM, nonce=_b64d(parts[1]))
    cipher.update(aad.encode())
    return cipher.decrypt_and_verify(_b64d(parts[3]), _b64d(parts[2])).decode()
