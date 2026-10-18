#!/usr/bin/env python3
"""Fetch only the signed EC2 instance identity document for the local runner."""

from __future__ import annotations

import http.client
import json
import os
import secrets
import stat
import sys
import time
from pathlib import Path

METADATA_HOST = "169.254.169.254"
TOKEN_PATH = "/latest/api/token"
DOCUMENT_PATH = "/latest/dynamic/instance-identity/document"
SIGNATURE_PATH = "/latest/dynamic/instance-identity/signature"
DIRECTORY = Path("/run/auterim-verifier-identity")
IDENTITY_FILE = DIRECTORY / "identity.json"
GROUP_ID = 62000
MAX_DOCUMENT_BYTES = 8192
MAX_SIGNATURE_BYTES = 2048
TOKEN_TTL_SECONDS = "60"
EXPECTED_ACCOUNT = "737759272471"
EXPECTED_REGION = "eu-west-1"
EXPECTED_INSTANCE = "i-0592719b99a518001"


class IdentityRefreshError(Exception):
    """A safe, non-secret operational failure category."""


def _metadata_request(method: str, path: str, *, token: str | None = None, body_limit: int):
    if path not in {TOKEN_PATH, DOCUMENT_PATH, SIGNATURE_PATH}:
        raise IdentityRefreshError("metadata_path_rejected")
    headers = {}
    if method == "PUT" and path == TOKEN_PATH:
        headers["X-aws-ec2-metadata-token-ttl-seconds"] = TOKEN_TTL_SECONDS
    elif method == "GET" and path in {DOCUMENT_PATH, SIGNATURE_PATH} and token:
        headers["X-aws-ec2-metadata-token"] = token
    else:
        raise IdentityRefreshError("metadata_request_rejected")

    connection = http.client.HTTPConnection(METADATA_HOST, timeout=2.0)
    try:
        connection.request(method, path, headers=headers)
        response = connection.getresponse()
        if response.status != 200:
            raise IdentityRefreshError("metadata_response_unavailable")
        value = response.read(body_limit + 1)
        if not value or len(value) > body_limit:
            raise IdentityRefreshError("metadata_response_invalid")
        return value
    except IdentityRefreshError:
        raise
    except Exception as exc:  # noqa: BLE001 - returned category is intentionally fixed
        raise IdentityRefreshError("metadata_unavailable") from exc
    finally:
        connection.close()


def fetch_identity(now_ms: int | None = None) -> dict[str, object]:
    """Fetch only IMDSv2 token + signed identity document/signature, never role credentials."""
    token = _metadata_request("PUT", TOKEN_PATH, body_limit=4096).decode("ascii").strip()
    if not token or len(token) > 4096 or any(ord(char) < 0x21 or ord(char) > 0x7E for char in token):
        raise IdentityRefreshError("metadata_token_invalid")
    document_bytes = _metadata_request(
        "GET", DOCUMENT_PATH, token=token, body_limit=MAX_DOCUMENT_BYTES
    )
    signature_bytes = _metadata_request(
        "GET", SIGNATURE_PATH, token=token, body_limit=MAX_SIGNATURE_BYTES
    )
    try:
        document = document_bytes.decode("utf-8")
        claims = json.loads(document)
        signature = _canonicalize_rsa_signature(signature_bytes)
    except Exception as exc:  # noqa: BLE001 - no untrusted data is included in error
        if isinstance(exc, IdentityRefreshError):
            raise
        raise IdentityRefreshError("metadata_identity_invalid") from exc
    if not isinstance(claims, dict) or (
        claims.get("accountId") != EXPECTED_ACCOUNT
        or claims.get("region") != EXPECTED_REGION
        or claims.get("instanceId") != EXPECTED_INSTANCE
        or not isinstance(claims.get("imageId"), str)
        or not claims["imageId"].startswith("ami-")
    ):
        raise IdentityRefreshError("metadata_identity_mismatch")
    return {
        "document": document,
        "signature": signature,
        "fetchedAt": int(time.time() * 1000) if now_ms is None else now_ms,
    }


def _canonicalize_rsa_signature(signature_bytes: bytes) -> str:
    """Accept ASCII-wrapped IMDS Base64, then return its strict canonical form."""
    import base64
    import binascii

    if not signature_bytes or len(signature_bytes) > MAX_SIGNATURE_BYTES:
        raise IdentityRefreshError("metadata_signature_invalid")
    allowed_whitespace = b" \t\r\n"
    if any(byte > 0x7F for byte in signature_bytes):
        raise IdentityRefreshError("metadata_signature_invalid")
    compact = bytes(byte for byte in signature_bytes if byte not in allowed_whitespace)
    if not compact:
        raise IdentityRefreshError("metadata_signature_invalid")
    try:
        decoded = base64.b64decode(compact, validate=True)
    except (ValueError, binascii.Error):
        raise IdentityRefreshError("metadata_signature_invalid") from None
    if len(decoded) != 128 or base64.b64encode(decoded) != compact:
        raise IdentityRefreshError("metadata_signature_invalid")
    return compact.decode("ascii")


def _ensure_directory() -> None:
    if os.geteuid() != 0:
        raise IdentityRefreshError("root_required")
    try:
        created = False
        try:
            DIRECTORY.mkdir(mode=0o750, parents=False, exist_ok=False)
            created = True
        except FileExistsError:
            pass
        info = DIRECTORY.lstat()
        if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
            raise IdentityRefreshError("identity_directory_unsafe")
        if created:
            os.chown(DIRECTORY, 0, GROUP_ID, follow_symlinks=False)
            os.chmod(DIRECTORY, 0o750, follow_symlinks=False)
            info = DIRECTORY.lstat()
        if info.st_uid != 0 or info.st_gid != GROUP_ID or stat.S_IMODE(info.st_mode) != 0o750:
            raise IdentityRefreshError("identity_directory_unsafe")
    except IdentityRefreshError:
        raise
    except Exception as exc:  # noqa: BLE001 - safe category only
        raise IdentityRefreshError("identity_directory_unavailable") from exc


def _write_identity(value: dict[str, object]) -> None:
    _ensure_directory()
    encoded = (json.dumps(value, separators=(",", ":"), sort_keys=True) + "\n").encode("utf-8")
    if len(encoded) > MAX_DOCUMENT_BYTES + MAX_SIGNATURE_BYTES + 512:
        raise IdentityRefreshError("identity_file_too_large")
    temporary = DIRECTORY / (".identity-" + secrets.token_hex(16) + ".tmp")
    descriptor = None
    try:
        descriptor = os.open(
            temporary,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0),
            0o600,
        )
        os.fchown(descriptor, 0, GROUP_ID)
        os.fchmod(descriptor, 0o440)
        with os.fdopen(descriptor, "wb", closefd=True) as output:
            descriptor = None
            output.write(encoded)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, IDENTITY_FILE)
        directory_fd = os.open(DIRECTORY, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    except IdentityRefreshError:
        raise
    except Exception as exc:  # noqa: BLE001 - safe category only
        raise IdentityRefreshError("identity_file_write_failed") from exc
    finally:
        if descriptor is not None:
            os.close(descriptor)
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def refresh() -> None:
    try:
        identity = fetch_identity()
        _write_identity(identity)
    except IdentityRefreshError:
        _remove_stale_file_if_safe()
        raise


def _remove_stale_file_if_safe() -> None:
    try:
        info = DIRECTORY.lstat()
        if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_uid != 0:
            return
        entry = IDENTITY_FILE.lstat()
        if stat.S_ISREG(entry.st_mode) and entry.st_uid == 0:
            IDENTITY_FILE.unlink()
    except FileNotFoundError:
        return
    except OSError:
        return


def main(argv: list[str]) -> int:
    if argv != ["--refresh"]:
        print('{"status":"blocked","category":"invalid_invocation"}')
        return 2
    try:
        refresh()
    except IdentityRefreshError as exc:
        print(json.dumps({"status": "blocked", "category": str(exc)}, separators=(",", ":")))
        return 1
    print('{"status":"refreshed"}')
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
