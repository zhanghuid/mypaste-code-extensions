#!/usr/bin/env python3
"""Offline ed25519 signing for official MyPaste extension packages.

The signing key never lives in this repository. It is a 32-byte ed25519 seed
kept in a file only the maintainer can read (0600, outside every repo), and
this script refuses to run with anything looser. The signature covers the
canonical content digest of the package directory — the exact algorithm the
MyPaste host uses for first-party provenance — so the installed directory and
the published archive verify against one signature.

Usage:
    python3 scripts/sign.py --package plugins/com.paste.ferry \
        --key-file ~/.mypaste/official-signing.key

    # Release review without the key: check an existing signature against the
    # public key embedded in the host binary.
    python3 scripts/sign.py --package plugins/com.mypaste.ferry \
        --public-key <64-hex> --verify <128-hex>

Prints two lines when signing: the content digest and the signature, both
lowercase hex. `--verify` exits 0 when the signature holds.
"""

from __future__ import annotations

import argparse
import hashlib
import os
import stat
import struct
import sys
from pathlib import Path

# The host refuses symlinks and special files instead of following them, and
# bounds the digest input; mirror both here so a package that signs here is
# exactly a package the host will digest there.
MAX_DIGEST_BYTES = 96 * 1024 * 1024

# ---------------------------------------------------------------------------
# Ed25519 signing, RFC 8032. Pure Python on purpose: the signing machine
# should not need third-party packages, and one signature per release makes
# speed irrelevant. Verification of everything we sign happens in the Go host
# against the embedded public key; this code only produces signatures.
# ---------------------------------------------------------------------------

P = 2**255 - 19
L = 2**252 + 27742317777372353535851937790883648493
D = (-121665 * pow(121666, P - 2, P)) % P
I = pow(2, (P - 1) // 4, P)


def _sha512(data: bytes) -> bytes:
    return hashlib.sha512(data).digest()


def _inv(x: int) -> int:
    return pow(x, P - 2, P)


def _xrecover(y: int) -> int:
    xx = (y * y - 1) * _inv(D * y * y + 1)
    x = pow(xx, (P + 3) // 8, P)
    if (x * x - xx) % P != 0:
        x = (x * I) % P
    if (x * x - xx) % P != 0:
        raise ValueError("point decompression failed")
    if (x & 1) != 0:
        x = P - x
    return x


_BY = 4 * _inv(5)
_BX = _xrecover(_BY)
_B = (_BX % P, _BY % P, 1, (_BX * _BY) % P)  # type: ignore
_IDENT = (0, 1, 1, 0)


def _edwards_add(pt1, pt2):
    x1, y1, z1, t1 = pt1
    x2, y2, z2, t2 = pt2
    a = (y1 - x1) * (y2 - x2) % P
    b = (y1 + x1) * (y2 + x2) % P
    c = t1 * 2 * D * t2 % P
    dd = z1 * 2 * z2 % P
    e, f, g, h = b - a, dd - c, dd + c, b + a
    return (e * f % P, g * h % P, f * g % P, e * h % P)


def _scalarmult(pt, n: int):
    result = _IDENT
    while n > 0:
        if n & 1:
            result = _edwards_add(result, pt)
        pt = _edwards_add(pt, pt)
        n >>= 1
    return result


def _encode_point(pt) -> bytes:
    x, y, z, t = pt
    zi = _inv(z)
    x = x * zi % P
    y = y * zi % P
    return ((y | ((x & 1) << 255))).to_bytes(32, "little")


def _decode_point(data: bytes):
    y = int.from_bytes(data, "little") & ((1 << 255) - 1)
    x = _xrecover(y)
    if x & 1 != (data[31] >> 7) & 1:
        x = P - x
    return (x, y, 1, x * y % P)


def _secret_expand(seed: bytes) -> tuple[bytes, bytes]:
    return _sha512(seed)[:32], _sha512(seed)[32:]


def ed25519_publickey(seed: bytes) -> bytes:
    a = _secret_expand(seed)[0]
    return _encode_point(_scalarmult(_B, int.from_bytes(a, "little")))


def ed25519_sign(seed: bytes, message: bytes) -> bytes:
    a, prefix = _secret_expand(seed)
    public = _encode_point(_scalarmult(_B, int.from_bytes(a, "little")))
    r = int.from_bytes(_sha512(prefix + message), "little") % L
    rp = _encode_point(_scalarmult(_B, r))
    h = int.from_bytes(_sha512(rp + public + message), "little") % L
    s = (r + h * int.from_bytes(a, "little")) % L
    return rp + s.to_bytes(32, "little")


def ed25519_verify(public: bytes, message: bytes, signature: bytes) -> bool:
    if len(public) != 32 or len(signature) != 64:
        return False
    a_point = _decode_point(public)
    r_point = _decode_point(signature[:32])
    s = int.from_bytes(signature[32:], "little")
    if s >= L:
        return False
    h = int.from_bytes(_sha512(signature[:32] + public + message), "little") % L
    left = _scalarmult(_B, s)
    right = _edwards_add(r_point, _scalarmult(a_point, h))
    return _encode_point(left) == _encode_point(right)


# ---------------------------------------------------------------------------
# Canonical content digest — the same algorithm as the host's
# extension.DirectoryContentDigest: files sorted by relative path, each
# contributing big-endian uint64 path length, path bytes, big-endian uint64
# content length, content bytes; SHA-256 over the concatenation, lowercase hex.
# ---------------------------------------------------------------------------


def content_digest(directory: Path) -> str:
    entries: list[tuple[str, bytes]] = []
    total = 0
    for path in sorted(directory.rglob("*")):
        if path.is_dir():
            continue
        if path.is_symlink() or not path.is_file():
            raise SystemExit(f"error: {path}: symlink or special file")
        relative = path.relative_to(directory).as_posix()
        data = path.read_bytes()
        total += len(data)
        if total > MAX_DIGEST_BYTES:
            raise SystemExit("error: package exceeds content digest bound")
        entries.append((relative, data))
    accumulator = hashlib.sha256()
    for relative, data in entries:
        accumulator.update(struct.pack(">Q", len(relative.encode("utf-8"))))
        accumulator.update(relative.encode("utf-8"))
        accumulator.update(struct.pack(">Q", len(data)))
        accumulator.update(data)
    return accumulator.hexdigest()


def load_seed(key_file: Path) -> bytes:
    mode = key_file.stat().st_mode
    if os.name != "nt" and mode & (stat.S_IRWXG | stat.S_IRWXO):
        raise SystemExit(
            f"error: {key_file} is readable by others; chmod 600 it first"
        )
    text = key_file.read_text(encoding="ascii").strip()
    for line in text.splitlines():
        line = line.strip()
        if line.startswith("seed="):
            line = line[len("seed="):].strip()
        if line and len(line) == 64:
            try:
                seed = bytes.fromhex(line)
            except ValueError:
                continue
            if len(seed) == 32:
                return seed
    raise SystemExit(f"error: {key_file}: no 64-hex-character seed found")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--package", required=True, type=Path)
    parser.add_argument("--key-file", type=Path)
    parser.add_argument("--public-key", help="32-byte public key hex for --verify")
    parser.add_argument("--verify", help="signature hex to verify instead of sign")
    args = parser.parse_args()

    digest = content_digest(args.package)
    if args.verify:
        if not args.public_key:
            parser.error("--public-key is required with --verify")
        try:
            signature = bytes.fromhex(args.verify)
            public = bytes.fromhex(args.public_key)
        except ValueError:
            raise SystemExit("error: --verify/--public-key must be hex")
        if not ed25519_verify(public, digest.encode("ascii"), signature):
            raise SystemExit(f"error: signature does not verify over {digest}")
        print(f"ok {digest}")
        return
    if not args.key_file:
        parser.error("--key-file is required without --verify")
    seed = load_seed(args.key_file)
    signature = ed25519_sign(seed, digest.encode("ascii"))
    print(digest)
    print(signature.hex())


if __name__ == "__main__":
    main()
