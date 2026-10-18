#!/usr/bin/env python3
"""Fail-closed operator preflight/deployment helper for the Auterim verifier."""

from __future__ import annotations

import hashlib
import ipaddress
import json
import os
import re
import shlex
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
try:
    import grp
except ImportError:  # The parser unit tests run on Windows; deployment runs on Ubuntu.
    grp = None
try:
    import pwd
except ImportError:  # The parser unit tests run on Windows; deployment runs on Ubuntu.
    pwd = None
from datetime import datetime, timezone
from pathlib import Path

SERVICE = "auterim-verification-runner.service"
SERVICE_PATH = Path("/etc/systemd/system/auterim-verification-runner.service")
ENV_PATH = "/etc/auterim-verifier/runner.env"
HELPER_PATH_VALUE = "/usr/local/bin/auterim-verifier-refresh-identity.py"
HELPER_PATH = Path(HELPER_PATH_VALUE)
REFRESH_SERVICE_PATH = Path("/etc/systemd/system/auterim-verifier-identity-refresh.service")
REFRESH_TIMER_PATH = Path("/etc/systemd/system/auterim-verifier-identity-refresh.timer")
IDENTITY_DIRECTORY_VALUE = "/run/auterim-verifier-identity"
IDENTITY_DIRECTORY = Path(IDENTITY_DIRECTORY_VALUE)
IMAGE_REF = "auterim-verification-runner:ac73ed8"
IMAGE_ARCHIVE_SHA256 = "cd53d09403387e9ecbd15748547a873691c04c28e67c57ce78e598bcf24c2b8c"
IMAGE_CONFIG_ID = "sha256:e923f5dc4ae35047cc76e10a0430a9cd0b6f122e3d34ea2c64c6bfb59a1e54c7"
IMAGE_IDS = (
    "sha256:dc150aabdf5c7ad152fe637c307b68d489887be2b834f447ff92b69d1671a230",
    IMAGE_CONFIG_ID,
)
HELPER_SHA256 = "e5f11b8aaafa921b8815b3ceb9e8700383a3e42ca4ba07cbf4968518883cf818"
IMAGE_ARCHIVE_NAME = "auterim-verification-runner-host-identity.tar"
EXPECTED_ENV_HANDOFFS = [
    "FIX_VERIFICATION_RUNNER_AUTH_SECRET",
    "FIX_VERIFICATION_RUNNER_WORK_ROOT",
    "FIX_DEPENDENCY_CACHE_PUBLIC_KEY",
    "NEXT_PUBLIC_SUPABASE_URL",
]
GROUP_ID = 62000
CONTAINER_NAME = "auterim-verification-runner"
JOB_STORE_PATH = Path("/srv/auterim-runner/jobs")
EXPECTED_ACCOUNT = "737759272471"
EXPECTED_REGION = "eu-west-1"
EXPECTED_INSTANCE = "i-0592719b99a518001"
BACKUP_ROOT = Path("/var/backups/auterim-verifier-identity-handoff")
MAX_IMAGE_ARCHIVE_BYTES = 1_000_000_000
MAX_IDENTITY_AGE_MS = 5 * 60 * 1000
MAX_IDENTITY_FILE_BYTES = 16_384
MAX_IDENTITY_AGE_MS = 5 * 60 * 1000
MAX_IDENTITY_FILE_BYTES = 16_384
MAX_IDENTITY_AGE_MS = 5 * 60 * 1000
MAX_IDENTITY_FILE_BYTES = 16_384

REFRESH_SERVICE = f"""[Unit]
Description=Refresh signed EC2 identity for the Auterim verifier
After=network-online.target

[Service]
Type=oneshot
User=root
UMask=0077
Environment=PATH=/usr/bin:/bin
Environment=PYTHONNOUSERSITE=1
UnsetEnvironment=AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_SECURITY_TOKEN AWS_PROFILE AWS_DEFAULT_PROFILE AWS_CONTAINER_CREDENTIALS_RELATIVE_URI AWS_CONTAINER_CREDENTIALS_FULL_URI
NoNewPrivileges=yes
ProtectHome=yes
ProtectSystem=strict
ReadWritePaths=-{IDENTITY_DIRECTORY_VALUE}
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
LockPersonality=yes
MemoryDenyWriteExecute=yes
RestrictAddressFamilies=AF_INET
CapabilityBoundingSet=CAP_CHOWN
ExecStart={HELPER_PATH_VALUE} --refresh
"""

REFRESH_TIMER = """[Unit]
Description=Keep the Auterim verifier EC2 identity fresh

[Timer]
OnBootSec=15s
OnUnitActiveSec=60s
AccuracySec=1s
RandomizedDelaySec=0
Unit=auterim-verifier-identity-refresh.service

[Install]
WantedBy=timers.target
"""


class PreflightError(Exception):
    def __init__(self, category: str):
        super().__init__(category)
        self.category = category


def _logical_lines(text: str) -> list[tuple[int, int, str]]:
    lines = text.splitlines(keepends=True)
    result: list[tuple[int, int, str]] = []
    start = 0
    buffer = ""
    active = False
    for index, physical in enumerate(lines):
        content = physical.rstrip("\r\n")
        if active:
            content = content.lstrip(" \t")
        trailing = len(content) - len(content.rstrip("\\"))
        if trailing % 2:
            buffer += content[:-1] + " "
            active = True
            continue
        buffer += content
        result.append((start, index, buffer))
        buffer = ""
        active = False
        start = index + 1
    if active:
        raise PreflightError("unit_continuation_unterminated")
    return result


def _service_directives(unit_text: str) -> dict[str, list[tuple[int, int, str]]]:
    section = ""
    directives: dict[str, list[tuple[int, int, str]]] = {}
    for start, end, line in _logical_lines(unit_text):
        value = line.strip()
        if not value or value.startswith(("#", ";")):
            continue
        if value.startswith("[") and value.endswith("]"):
            section = value[1:-1].strip()
            continue
        if section != "Service" or "=" not in value:
            continue
        key, content = value.split("=", 1)
        directives.setdefault(key.strip(), []).append((start, end, content.strip()))
    return directives


def _split_execstart(value: str, *, allow_identity_mount: bool = False) -> tuple[list[str], str, str]:
    try:
        argv = shlex.split(value, posix=True)
    except ValueError as exc:
        raise PreflightError("systemd_execstart_parse_invalid") from exc
    if len(argv) != 3 or argv[:2] != ["/bin/sh", "-lc"]:
        raise PreflightError("systemd_shell_wrapper_shape_unsupported")
    shell = argv[2]
    expected_substitution = "$(stat -c %%g /var/run/docker.sock)"
    if shell.count(expected_substitution) != 1:
        raise PreflightError("systemd_shell_substitution_unsupported")
    if any(
        char in shell.replace(expected_substitution, "")
        for char in ("$", "%", "`", ";", "&", "|", "<", ">")
    ):
        raise PreflightError("systemd_shell_operator_unsupported")
    try:
        command = shlex.split(shell, posix=True)
    except ValueError as exc:
        raise PreflightError("systemd_inner_command_parse_invalid") from exc
    if len(command) < 8 or command[0] != "exec" or command[1] not in {"docker", "/usr/bin/docker"} or command[2] != "run":
        raise PreflightError("systemd_docker_run_shape_unsupported")
    if command[-1] != IMAGE_REF:
        raise PreflightError("systemd_runner_image_ref_mismatch")
    if command.count("--name") != 1 or command[command.index("--name") + 1] != CONTAINER_NAME:
        raise PreflightError("systemd_runner_name_mismatch")
    if command.count("--env") != len(EXPECTED_ENV_HANDOFFS):
        raise PreflightError("systemd_environment_handoff_count_mismatch")
    handoffs = []
    for index, token in enumerate(command[:-1]):
        if token == "--env":
            if index + 1 >= len(command) - 1:
                raise PreflightError("systemd_environment_handoff_invalid")
            handoffs.append(command[index + 1])
    if handoffs != EXPECTED_ENV_HANDOFFS:
        raise PreflightError("systemd_environment_handoff_mismatch")
    if not allow_identity_mount and any("/run/auterim-verifier-identity" in token for token in command):
        raise PreflightError("identity_handoff_already_present")
    expected_mount_count = 3 if allow_identity_mount else 2
    if command.count("--mount") != expected_mount_count or command.count("--publish") != 1:
        raise PreflightError("systemd_existing_mount_or_publish_shape_mismatch")
    mount_values = [command[index + 1] for index, token in enumerate(command[:-1]) if token == "--mount"]
    expected_existing_mounts = {
        "type=bind,source=/srv/auterim-runner,target=/srv/auterim-runner",
        "type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock",
    }
    identity_mount_value = (
        f"type=bind,source={IDENTITY_DIRECTORY_VALUE},target={IDENTITY_DIRECTORY_VALUE},readonly"
    )
    if allow_identity_mount:
        expected_existing_mounts.add(identity_mount_value)
    if set(mount_values) != expected_existing_mounts or len(mount_values) != len(expected_existing_mounts):
        raise PreflightError("runner_job_store_mount_mismatch")
    group_args = [command[index + 1] for index, token in enumerate(command[:-1]) if token == "--group-add"]
    if not group_args or group_args[0] != expected_substitution:
        raise PreflightError("systemd_docker_group_handoff_mismatch")
    if allow_identity_mount:
        identity_mount = f"type=bind,source={IDENTITY_DIRECTORY_VALUE},target={IDENTITY_DIRECTORY_VALUE},readonly"
        if group_args != [expected_substitution, str(GROUP_ID)] or command.count(identity_mount) != 1:
            raise PreflightError("systemd_identity_handoff_mismatch")
    elif len(group_args) != 1:
        raise PreflightError("systemd_docker_group_handoff_mismatch")
    publish_values = [
        command[index + 1]
        for index, token in enumerate(command[:-1])
        if token == "--publish"
    ]
    if len(publish_values) != 1:
        raise PreflightError("systemd_publish_binding_unsafe")
    publish_binding = parse_publish_binding(publish_values[0])
    pull_policies = [token.split("=", 1)[1] for token in command if token.startswith("--pull=")]
    pull_positions = [index for index, token in enumerate(command[:-1]) if token == "--pull"]
    pull_policies.extend(command[index + 1] for index in pull_positions)
    if len(pull_policies) > 1 or (pull_policies and pull_policies[0] not in {"never", "missing"}):
        raise PreflightError("runner_pull_policy_not_safe_for_pinned_local_image")
    pull_policy = "missing" if not pull_policies else pull_policies[0]
    expected = [
        "exec",
        command[1],
        "run",
        "--rm",
        "--name",
        CONTAINER_NAME,
        f"--pull={pull_policy}",
        "--group-add",
        expected_substitution,
        "--publish",
        publish_values[0],
    ]
    for mount in mount_values:
        if allow_identity_mount and mount == identity_mount_value:
            continue
        expected.extend(["--mount", mount])
    for name in EXPECTED_ENV_HANDOFFS:
        expected.extend(["--env", name])
    if allow_identity_mount:
        expected.extend(
            [
                "--group-add",
                str(GROUP_ID),
                "--mount",
                identity_mount_value,
            ]
        )
    expected.append(IMAGE_REF)
    if command != expected:
        raise PreflightError("systemd_docker_invocation_has_unapproved_arguments")
    return command, shell, pull_policy


def parse_publish_binding(value: str) -> dict[str, str]:
    try:
        port_spec, protocol = (value.split("/", 1) + ["tcp"])[:2] if "/" in value else (value, "tcp")
        if protocol != "tcp":
            raise ValueError()
        fields = port_spec.rsplit(":", 2)
        if len(fields) == 2:
            host_ip, host_port, container_port = "0.0.0.0", fields[0], fields[1]
        elif len(fields) == 3:
            host_ip, host_port, container_port = fields
        else:
            raise ValueError()
        address = str(ipaddress.ip_address(host_ip))
        if (
            not host_port.isdigit()
            or not 1 <= int(host_port) <= 65535
            or container_port != "8080"
        ):
            raise ValueError()
        return {"hostIp": address, "hostPort": str(int(host_port)), "containerPort": "8080", "protocol": "tcp"}
    except Exception as exc:  # noqa: BLE001 - fixed safe category
        raise PreflightError("systemd_publish_binding_unsafe") from exc


def publish_binding_matches_runtime(binding: dict[str, str], runtime_ports: object) -> bool:
    if not isinstance(runtime_ports, dict) or set(runtime_ports) != {"8080/tcp"}:
        return False
    entries = runtime_ports.get("8080/tcp")
    if not isinstance(entries, list) or len(entries) != 1 or not isinstance(entries[0], dict):
        return False
    return entries[0] == {"HostIp": binding["hostIp"], "HostPort": binding["hostPort"]}


def validate_identity_record(raw: bytes, now_ms: int) -> None:
    try:
        if len(raw) > MAX_IDENTITY_FILE_BYTES:
            raise ValueError()
        value = json.loads(raw.decode("utf-8"))
        if not isinstance(value, dict) or set(value) != {"document", "signature", "fetchedAt"}:
            raise ValueError()
        if (
            not isinstance(value["document"], str)
            or not isinstance(value["signature"], str)
            or not isinstance(value["fetchedAt"], int)
            or isinstance(value["fetchedAt"], bool)
            or value["fetchedAt"] <= 0
            or value["fetchedAt"] > now_ms + 5_000
            or now_ms - value["fetchedAt"] > MAX_IDENTITY_AGE_MS
        ):
            raise ValueError()
        claims = json.loads(value["document"])
        signature = value["signature"]
        import base64

        decoded = base64.b64decode(signature, validate=True)
        if (
            not isinstance(claims, dict)
            or claims.get("accountId") != EXPECTED_ACCOUNT
            or claims.get("region") != EXPECTED_REGION
            or claims.get("instanceId") != EXPECTED_INSTANCE
            or not isinstance(claims.get("imageId"), str)
            or not re.fullmatch(r"ami-[a-f0-9]+", claims["imageId"])
            or len(decoded) != 256
            or base64.b64encode(decoded).decode("ascii") != signature
        ):
            raise ValueError()
    except Exception as exc:  # noqa: BLE001 - no identity data in errors
        raise PreflightError("host_identity_record_invalid_or_stale") from exc


def validate_host_identity_file(now_ms: int | None = None) -> None:
    identity_file = IDENTITY_DIRECTORY / "identity.json"
    try:
        directory_stat = IDENTITY_DIRECTORY.lstat()
        file_stat = identity_file.lstat()
        if (
            not stat.S_ISDIR(directory_stat.st_mode)
            or stat.S_ISLNK(directory_stat.st_mode)
            or directory_stat.st_uid != 0
            or directory_stat.st_gid != GROUP_ID
            or stat.S_IMODE(directory_stat.st_mode) != 0o750
            or not stat.S_ISREG(file_stat.st_mode)
            or stat.S_ISLNK(file_stat.st_mode)
            or file_stat.st_uid != 0
            or file_stat.st_gid != GROUP_ID
            or stat.S_IMODE(file_stat.st_mode) != 0o440
            or file_stat.st_nlink != 1
            or file_stat.st_size < 1
            or file_stat.st_size > MAX_IDENTITY_FILE_BYTES
        ):
            raise PreflightError("host_identity_file_permissions_unsafe")
        validate_identity_record(identity_file.read_bytes(), int(time.time() * 1000) if now_ms is None else now_ms)
    except PreflightError:
        raise
    except OSError as exc:
        raise PreflightError("host_identity_file_unavailable") from exc


def validate_identity_record(raw: bytes, now_ms: int) -> None:
    try:
        if len(raw) > MAX_IDENTITY_FILE_BYTES:
            raise ValueError()
        value = json.loads(raw.decode("utf-8"))
        if not isinstance(value, dict) or set(value) != {"document", "signature", "fetchedAt"}:
            raise ValueError()
        if (
            not isinstance(value["document"], str)
            or not isinstance(value["signature"], str)
            or not isinstance(value["fetchedAt"], int)
            or isinstance(value["fetchedAt"], bool)
            or value["fetchedAt"] <= 0
            or value["fetchedAt"] > now_ms + 5_000
            or now_ms - value["fetchedAt"] > MAX_IDENTITY_AGE_MS
        ):
            raise ValueError()
        claims = json.loads(value["document"])
        signature = value["signature"]
        import base64

        decoded = base64.b64decode(signature, validate=True)
        if (
            not isinstance(claims, dict)
            or claims.get("accountId") != EXPECTED_ACCOUNT
            or claims.get("region") != EXPECTED_REGION
            or claims.get("instanceId") != EXPECTED_INSTANCE
            or not isinstance(claims.get("imageId"), str)
            or not re.fullmatch(r"ami-[a-f0-9]+", claims["imageId"])
            or len(decoded) != 256
            or base64.b64encode(decoded).decode("ascii") != signature
        ):
            raise ValueError()
    except Exception as exc:  # noqa: BLE001 - no identity data in errors
        raise PreflightError("host_identity_record_invalid_or_stale") from exc


def validate_host_identity_file(now_ms: int | None = None) -> None:
    identity_file = IDENTITY_DIRECTORY / "identity.json"
    try:
        directory_stat = IDENTITY_DIRECTORY.lstat()
        file_stat = identity_file.lstat()
        if (
            not stat.S_ISDIR(directory_stat.st_mode)
            or stat.S_ISLNK(directory_stat.st_mode)
            or directory_stat.st_uid != 0
            or directory_stat.st_gid != GROUP_ID
            or stat.S_IMODE(directory_stat.st_mode) != 0o750
            or not stat.S_ISREG(file_stat.st_mode)
            or stat.S_ISLNK(file_stat.st_mode)
            or file_stat.st_uid != 0
            or file_stat.st_gid != GROUP_ID
            or stat.S_IMODE(file_stat.st_mode) != 0o440
            or file_stat.st_nlink != 1
            or file_stat.st_size < 1
            or file_stat.st_size > MAX_IDENTITY_FILE_BYTES
        ):
            raise PreflightError("host_identity_file_permissions_unsafe")
        validate_identity_record(identity_file.read_bytes(), int(time.time() * 1000) if now_ms is None else now_ms)
    except PreflightError:
        raise
    except OSError as exc:
        raise PreflightError("host_identity_file_unavailable") from exc


def validate_identity_record(raw: bytes, now_ms: int) -> None:
    try:
        if len(raw) > MAX_IDENTITY_FILE_BYTES:
            raise ValueError()
        value = json.loads(raw.decode("utf-8"))
        if not isinstance(value, dict) or set(value) != {"document", "signature", "fetchedAt"}:
            raise ValueError()
        if (
            not isinstance(value["document"], str)
            or not isinstance(value["signature"], str)
            or not isinstance(value["fetchedAt"], int)
            or isinstance(value["fetchedAt"], bool)
            or value["fetchedAt"] <= 0
            or value["fetchedAt"] > now_ms + 5_000
            or now_ms - value["fetchedAt"] > MAX_IDENTITY_AGE_MS
        ):
            raise ValueError()
        claims = json.loads(value["document"])
        signature = value["signature"]
        import base64

        decoded = base64.b64decode(signature, validate=True)
        if (
            not isinstance(claims, dict)
            or claims.get("accountId") != EXPECTED_ACCOUNT
            or claims.get("region") != EXPECTED_REGION
            or claims.get("instanceId") != EXPECTED_INSTANCE
            or not isinstance(claims.get("imageId"), str)
            or not re.fullmatch(r"ami-[a-f0-9]+", claims["imageId"])
            or len(decoded) != 256
            or base64.b64encode(decoded).decode("ascii") != signature
        ):
            raise ValueError()
    except Exception as exc:  # noqa: BLE001 - no identity data in errors
        raise PreflightError("host_identity_record_invalid_or_stale") from exc


def validate_host_identity_file(now_ms: int | None = None) -> None:
    identity_file = IDENTITY_DIRECTORY / "identity.json"
    try:
        directory_stat = IDENTITY_DIRECTORY.lstat()
        file_stat = identity_file.lstat()
        if (
            not stat.S_ISDIR(directory_stat.st_mode)
            or stat.S_ISLNK(directory_stat.st_mode)
            or directory_stat.st_uid != 0
            or directory_stat.st_gid != GROUP_ID
            or stat.S_IMODE(directory_stat.st_mode) != 0o750
            or not stat.S_ISREG(file_stat.st_mode)
            or stat.S_ISLNK(file_stat.st_mode)
            or file_stat.st_uid != 0
            or file_stat.st_gid != GROUP_ID
            or stat.S_IMODE(file_stat.st_mode) != 0o440
            or file_stat.st_nlink != 1
            or file_stat.st_size < 1
            or file_stat.st_size > MAX_IDENTITY_FILE_BYTES
        ):
            raise PreflightError("host_identity_file_permissions_unsafe")
        validate_identity_record(identity_file.read_bytes(), int(time.time() * 1000) if now_ms is None else now_ms)
    except PreflightError:
        raise
    except OSError as exc:
        raise PreflightError("host_identity_file_unavailable") from exc


def validate_unit(unit_text: str, *, allow_identity_mount: bool = False) -> dict[str, object]:
    directives = _service_directives(unit_text)
    if any(
        directives.get(name)
        for name in ("ExecCondition", "ExecStartPost", "ExecReload", "ExecStop", "ExecStopPost")
    ):
        raise PreflightError("systemd_extra_execution_directive_unsupported")
    exec_starts = directives.get("ExecStart", [])
    if len(exec_starts) != 1:
        raise PreflightError("systemd_execstart_count_mismatch")
    prestart = directives.get("ExecStartPre", [])
    if (prestart and not allow_identity_mount) or (
        allow_identity_mount
        and (len(prestart) != 1 or prestart[0][2] != "-/usr/bin/systemctl start auterim-verifier-identity-refresh.service")
    ):
        raise PreflightError("systemd_execstartpre_mismatch")
    command, shell, pull_policy = _split_execstart(
        exec_starts[0][2], allow_identity_mount=allow_identity_mount
    )
    environment_files = directives.get("EnvironmentFile", [])
    if len(environment_files) != 1 or environment_files[0][2].lstrip("-") != ENV_PATH:
        raise PreflightError("systemd_environment_file_mismatch")
    restarts = directives.get("Restart", [])
    if len(restarts) > 1:
        raise PreflightError("systemd_restart_policy_ambiguous")
    return {
        "command": command,
        "shell": shell,
        "restart": restarts[0][2] if restarts else "no",
        "environment_file_count": len(environment_files),
        "pull_policy": pull_policy,
    }


def patch_unit(unit_text: str) -> str:
    validate_unit(unit_text)
    marker = f" {IMAGE_REF}'"
    inserted = (
        " --group-add 62000"
        " --mount type=bind,source=/run/auterim-verifier-identity,target=/run/auterim-verifier-identity,readonly"
        f" {IMAGE_REF}'"
    )
    if unit_text.count(marker) != 1:
        raise PreflightError("systemd_image_token_not_unique")
    updated = unit_text.replace(marker, inserted, 1)
    newline = "\r\n" if "\r\n" in updated else "\n"
    service_header = f"[Service]{newline}"
    if updated.count(service_header) != 1:
        raise PreflightError("systemd_service_section_ambiguous")
    updated = updated.replace(
        service_header,
        service_header + f"ExecStartPre=-/usr/bin/systemctl start auterim-verifier-identity-refresh.service{newline}",
        1,
    )
    before = validate_unit(unit_text)["command"]
    after = validate_unit(updated, allow_identity_mount=True)["command"]
    added = [
        "--group-add",
        str(GROUP_ID),
        "--mount",
        f"type=bind,source={IDENTITY_DIRECTORY_VALUE},target={IDENTITY_DIRECTORY_VALUE},readonly",
    ]
    if after != before[:-1] + added + [IMAGE_REF]:
        raise PreflightError("systemd_candidate_semantics_mismatch")
    return updated


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def image_id_from_docker_archive(path: Path) -> str:
    if path.stat().st_size > MAX_IMAGE_ARCHIVE_BYTES:
        raise PreflightError("image_archive_too_large")
    try:
        with tarfile.open(path, "r:") as archive:
            manifest_member = archive.getmember("manifest.json")
            if not manifest_member.isfile() or manifest_member.size > 64 * 1024:
                raise PreflightError("image_archive_manifest_invalid")
            manifest_raw = archive.extractfile(manifest_member)
            if manifest_raw is None:
                raise PreflightError("image_archive_manifest_invalid")
            manifest = json.loads(manifest_raw.read(64 * 1024 + 1))
            if not isinstance(manifest, list) or len(manifest) != 1:
                raise PreflightError("image_archive_identity_mismatch")
            entry = manifest[0]
            if not isinstance(entry, dict) or entry.get("RepoTags") != [IMAGE_REF]:
                raise PreflightError("image_archive_identity_mismatch")
            config_name = entry.get("Config")
            if (
                not isinstance(config_name, str)
                or not re.fullmatch(r"blobs/sha256/[a-f0-9]{64}", config_name)
                or config_name.rsplit("/", 1)[1] != IMAGE_CONFIG_ID.split(":", 1)[1]
            ):
                raise PreflightError("image_archive_config_invalid")
            member = archive.getmember(config_name)
            if not member.isfile() or member.size > 4 * 1024 * 1024:
                raise PreflightError("image_archive_config_invalid")
            raw = archive.extractfile(member)
            if raw is None:
                raise PreflightError("image_archive_config_invalid")
            config = raw.read(4 * 1024 * 1024 + 1)
            if len(config) != member.size or len(config) > 4 * 1024 * 1024:
                raise PreflightError("image_archive_config_invalid")
            return "sha256:" + hashlib.sha256(config).hexdigest()
    except PreflightError:
        raise
    except Exception as exc:  # noqa: BLE001 - category only
        raise PreflightError("image_archive_invalid") from exc


def _run(args: list[str], *, timeout: int = 15, check: bool = True) -> str:
    try:
        result = subprocess.run(args, check=False, capture_output=True, text=True, timeout=timeout)
    except Exception as exc:  # noqa: BLE001 - never include command output
        raise PreflightError("operator_command_unavailable") from exc
    if check and result.returncode != 0:
        raise PreflightError("operator_command_failed")
    return result.stdout.strip()


def _systemd_value(name: str) -> str:
    return _run(["systemctl", "show", SERVICE, f"--property={name}", "--value"])


def _inspect_running_container() -> dict[str, object]:
    template = "{{.Id}}|{{.Image}}|{{.Config.Image}}|{{.State.Running}}|{{.State.Health.Status}}|{{.HostConfig.RestartPolicy.Name}}|{{json .Mounts}}|{{json .HostConfig.GroupAdd}}|{{json .HostConfig.PortBindings}}"
    output = _run(["docker", "inspect", "--format", template, CONTAINER_NAME])
    try:
        values = output.split("|", 8)
        if len(values) != 9:
            raise ValueError()
        mounts = json.loads(values[6])
        groups = json.loads(values[7])
        port_bindings = json.loads(values[8])
    except Exception as exc:  # noqa: BLE001 - category only
        raise PreflightError("runner_container_inspect_invalid") from exc
    if "|" in values[6] or not isinstance(mounts, list) or not isinstance(groups, list):
        raise PreflightError("runner_container_inspect_invalid")
    return {
        "id": values[0],
        "image_id": values[1],
        "image_ref": values[2],
        "running": values[3].lower() == "true",
        "health": values[4],
        "restart_policy": values[5],
        "mounts": mounts,
        "groups": groups,
        "port_bindings": port_bindings,
    }


def _assert_identity_mount_reserved(expected_container_id: str | None = None) -> None:
    try:
        container_ids = [value for value in _run(["docker", "ps", "--quiet", "--no-trunc"]).splitlines() if value]
        if len(container_ids) > 256:
            raise PreflightError("docker_container_inventory_too_large")
        matches: list[str] = []
        for container_id in container_ids:
            output = _run(
                [
                    "docker",
                    "inspect",
                    "--format={{.Id}}|{{json .Mounts}}",
                    container_id,
                ]
            )
            image_id, mounts_json = output.split("|", 1)
            mounts = json.loads(mounts_json)
            if any(
                isinstance(mount, dict)
                and (
                    mount.get("Source") == IDENTITY_DIRECTORY_VALUE
                    or mount.get("Destination") == IDENTITY_DIRECTORY_VALUE
                )
                for mount in mounts
            ):
                matches.append(image_id)
        if expected_container_id is None:
            if matches:
                raise PreflightError("identity_mount_in_use")
        elif matches != [expected_container_id]:
            raise PreflightError("identity_mount_scope_mismatch")
    except PreflightError:
        raise
    except Exception as exc:  # noqa: BLE001 - no container command output emitted
        raise PreflightError("docker_container_inventory_unavailable") from exc


def _validate_runtime_properties(unit_text: str) -> dict[str, object]:
    properties = {
        "need_daemon_reload": _systemd_value("NeedDaemonReload"),
        "fragment_path": _systemd_value("FragmentPath"),
        "dropins": _systemd_value("DropInPaths"),
        "environment_files": _systemd_value("EnvironmentFiles"),
        "active_state": _systemd_value("ActiveState"),
        "restart": _systemd_value("Restart"),
    }
    expected_environment = str(ENV_PATH)
    if properties["need_daemon_reload"].lower() != "no":
        raise PreflightError("systemd_unit_reload_pending")
    if properties["fragment_path"] != str(SERVICE_PATH) or properties["dropins"]:
        raise PreflightError("systemd_effective_unit_mismatch")
    if properties["active_state"] != "active":
        raise PreflightError("runner_service_inactive")
    if expected_environment not in properties["environment_files"]:
        raise PreflightError("systemd_effective_environment_mismatch")
    source = validate_unit(unit_text)
    if properties["restart"] != source["restart"]:
        raise PreflightError("systemd_restart_policy_mismatch")
    return properties


def _validate_archive(image_path: Path, helper_path: Path) -> dict[str, str]:
    if (
        image_path.is_symlink()
        or not image_path.is_file()
        or image_path.stat().st_size > MAX_IMAGE_ARCHIVE_BYTES
        or sha256_file(image_path) != IMAGE_ARCHIVE_SHA256
    ):
        raise PreflightError("image_archive_fingerprint_mismatch")
    if image_id_from_docker_archive(image_path) != IMAGE_CONFIG_ID:
        raise PreflightError("image_archive_image_id_mismatch")
    if (
        helper_path.is_symlink()
        or not helper_path.is_file()
        or helper_path.stat().st_size > 1_000_000
        or sha256_file(helper_path) != HELPER_SHA256
    ):
        raise PreflightError("host_helper_fingerprint_mismatch")
    return {
        "image_config_id": IMAGE_CONFIG_ID,
        "image_ids": list(IMAGE_IDS),
        "image_archive_sha256": IMAGE_ARCHIVE_SHA256,
        "helper_sha256": HELPER_SHA256,
    }


def _stage_input_file(source: Path, destination: Path, maximum_bytes: int) -> None:
    try:
        source_info = source.lstat()
        if (
            not stat.S_ISREG(source_info.st_mode)
            or stat.S_ISLNK(source_info.st_mode)
            or source_info.st_size < 1
            or source_info.st_size > maximum_bytes
        ):
            raise PreflightError("deployment_artifact_input_unsafe")
        source_fd = os.open(source, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        try:
            opened_info = os.fstat(source_fd)
            if (
                not stat.S_ISREG(opened_info.st_mode)
                or (opened_info.st_dev, opened_info.st_ino)
                != (source_info.st_dev, source_info.st_ino)
                or opened_info.st_size != source_info.st_size
            ):
                raise PreflightError("deployment_artifact_input_changed")
            flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
            destination_fd = os.open(destination, flags, 0o600)
            try:
                total = 0
                with os.fdopen(source_fd, "rb", closefd=False) as incoming, os.fdopen(
                    destination_fd, "wb", closefd=False
                ) as outgoing:
                    while True:
                        chunk = incoming.read(1024 * 1024)
                        if not chunk:
                            break
                        total += len(chunk)
                        if total > maximum_bytes:
                            raise PreflightError("deployment_artifact_input_oversized")
                        outgoing.write(chunk)
                    outgoing.flush()
                    os.fsync(outgoing.fileno())
                after_info = os.fstat(source_fd)
                if (
                    total != source_info.st_size
                    or (after_info.st_dev, after_info.st_ino, after_info.st_size)
                    != (source_info.st_dev, source_info.st_ino, source_info.st_size)
                ):
                    raise PreflightError("deployment_artifact_input_changed")
                if os.name == "posix":
                    os.fchown(destination_fd, 0, 0)
                    os.fchmod(destination_fd, 0o600)
                    os.fsync(destination_fd)
            finally:
                os.close(destination_fd)
        finally:
            os.close(source_fd)
    except PreflightError:
        raise
    except Exception as exc:  # noqa: BLE001 - fixed safe category only
        raise PreflightError("deployment_artifact_input_unavailable") from exc


def assert_no_active_jobs(job_store: Path = JOB_STORE_PATH) -> int:
    try:
        root_info = job_store.lstat()
    except OSError as exc:
        raise PreflightError("runner_job_store_unavailable") from exc
    if not stat.S_ISDIR(root_info.st_mode) or stat.S_ISLNK(root_info.st_mode):
        raise PreflightError("runner_job_store_unsafe")
    active = 0
    try:
        for entry in job_store.iterdir():
            entry_stat = entry.lstat()
            if entry.name == "artifacts":
                if not stat.S_ISDIR(entry_stat.st_mode) or stat.S_ISLNK(entry_stat.st_mode):
                    raise PreflightError("runner_job_store_unsafe")
                for spool_entry in entry.iterdir():
                    if spool_entry.name.endswith(".admitting") or re.search(
                        r"\.[a-f0-9]{64}\.[0-9a-f-]{36}\.admitting$", spool_entry.name
                    ):
                        raise PreflightError("runner_admission_in_progress")
                continue
            if entry.name.endswith((".tmp", ".admitting")):
                raise PreflightError("runner_admission_in_progress")
            if (
                not re.fullmatch(r"[a-f0-9]{64}\.json", entry.name)
                or not stat.S_ISREG(entry_stat.st_mode)
                or entry_stat.st_size > 64 * 1024
            ):
                raise PreflightError("runner_job_store_entry_invalid")
            try:
                record = json.loads(entry.read_text(encoding="utf-8"))
                status = record["state"]["status"]
            except Exception as exc:  # noqa: BLE001 - no record contents are returned
                raise PreflightError("runner_job_store_entry_invalid") from exc
            if status not in {"queued", "running", "completed", "failed"}:
                raise PreflightError("runner_job_store_entry_invalid")
            if status in {"queued", "running"}:
                active += 1
        if active:
            raise PreflightError("runner_has_active_jobs")
        return active
    except PreflightError:
        raise
    except OSError as exc:
        raise PreflightError("runner_job_store_unavailable") from exc


def preflight(image_path: Path, helper_path: Path) -> dict[str, object]:
    if os.geteuid() != 0:
        raise PreflightError("root_required")
    if not SERVICE_PATH.is_file() or SERVICE_PATH.is_symlink():
        raise PreflightError("systemd_unit_unavailable")
    unit_stat = SERVICE_PATH.stat()
    if unit_stat.st_uid != 0 or unit_stat.st_gid != 0 or stat.S_IMODE(unit_stat.st_mode) not in {0o644, 0o640}:
        raise PreflightError("systemd_unit_permissions_unsafe")
    for parent in (SERVICE_PATH.parent, HELPER_PATH.parent):
        try:
            parent_stat = parent.lstat()
        except OSError as exc:
            raise PreflightError("systemd_parent_directory_unavailable") from exc
        if (
            not stat.S_ISDIR(parent_stat.st_mode)
            or stat.S_ISLNK(parent_stat.st_mode)
            or parent_stat.st_uid != 0
            or parent_stat.st_gid != 0
            or stat.S_IMODE(parent_stat.st_mode) & 0o022
        ):
            raise PreflightError("systemd_parent_directory_unsafe")
    unit_text = SERVICE_PATH.read_text(encoding="utf-8")
    source = validate_unit(unit_text)
    systemd = _validate_runtime_properties(unit_text)
    runtime = _inspect_running_container()
    inactive_jobs = assert_no_active_jobs()
    if (
        runtime["running"] is not True
        or runtime["health"] != "healthy"
        or runtime["image_ref"] != IMAGE_REF
        or not isinstance(runtime["image_id"], str)
        or not re.fullmatch(r"sha256:[a-f0-9]{64}", runtime["image_id"])
    ):
        raise PreflightError("current_runner_not_healthy_or_expected")
    try:
        published = source["command"][source["command"].index("--publish") + 1]
    except (ValueError, IndexError) as exc:
        raise PreflightError("systemd_publish_binding_unsafe") from exc
    if not publish_binding_matches_runtime(
        parse_publish_binding(published), runtime.get("port_bindings")
    ):
        raise PreflightError("runner_publish_binding_mismatch")
    if runtime["restart_policy"] is None:
        raise PreflightError("runner_restart_policy_unavailable")
    if runtime["groups"] is None or GROUP_ID in runtime["groups"] or str(GROUP_ID) in runtime["groups"]:
        raise PreflightError("identity_group_already_present")
    mounts = runtime["mounts"]
    if not isinstance(mounts, list) or len(mounts) != 2:
        raise PreflightError("current_runner_mount_shape_mismatch")
    if not any(
        isinstance(item, dict)
        and item.get("Type") == "bind"
        and item.get("Source") == "/var/run/docker.sock"
        and item.get("Destination") == "/var/run/docker.sock"
        for item in mounts
    ) or not any(
        isinstance(item, dict)
        and item.get("Type") == "bind"
        and item.get("Source") == "/srv/auterim-runner"
        and item.get("Destination") == "/srv/auterim-runner"
        for item in mounts
    ):
        raise PreflightError("current_runner_mount_identity_mismatch")
    if any(
        isinstance(item, dict)
        and (item.get("Source") == str(IDENTITY_DIRECTORY) or item.get("Destination") == str(IDENTITY_DIRECTORY))
        for item in mounts
    ):
        raise PreflightError("identity_mount_already_present")
    if any(
        path.exists() or path.is_symlink()
        for path in (REFRESH_SERVICE_PATH, REFRESH_TIMER_PATH, HELPER_PATH)
    ):
        raise PreflightError("identity_handoff_files_already_exist")
    if IDENTITY_DIRECTORY.exists() or IDENTITY_DIRECTORY.is_symlink():
        raise PreflightError("identity_runtime_path_already_exists")
    if grp is None:
        raise PreflightError("host_group_database_unavailable")
    if any(group.gr_gid == GROUP_ID for group in grp.getgrall()):
        raise PreflightError("identity_group_in_use")
    if pwd is None or any(user.pw_gid == GROUP_ID for user in pwd.getpwall()):
        raise PreflightError("identity_group_in_use")
    environment_file = Path(ENV_PATH)
    try:
        environment_info = environment_file.lstat()
    except OSError as exc:
        raise PreflightError("runner_environment_file_unavailable") from exc
    if (
        not stat.S_ISREG(environment_info.st_mode)
        or stat.S_ISLNK(environment_info.st_mode)
        or environment_info.st_uid != 0
        or stat.S_IMODE(environment_info.st_mode) not in {0o600, 0o640}
        or (stat.S_IMODE(environment_info.st_mode) == 0o640 and environment_info.st_gid != 0)
    ):
        raise PreflightError("runner_environment_file_unavailable")
    _assert_identity_mount_reserved()
    artifact = _validate_archive(image_path, helper_path)
    proposed = patch_unit(unit_text)
    with tempfile.TemporaryDirectory(prefix="m1578r-runner-", dir="/tmp") as temporary_directory:
        temporary_root = Path(temporary_directory)
        staged_helper = temporary_root / "fetch_ec2_identity.py"
        staged_helper.write_bytes(helper_path.read_bytes())
        os.chmod(staged_helper, 0o750)
        runner_unit = temporary_root / SERVICE
        refresh_unit = temporary_root / "auterim-verifier-identity-refresh.service"
        refresh_timer = temporary_root / "auterim-verifier-identity-refresh.timer"
        runner_unit.write_text(proposed, encoding="utf-8")
        refresh_unit.write_text(REFRESH_SERVICE.replace(str(HELPER_PATH), str(staged_helper)), encoding="utf-8")
        refresh_timer.write_text(REFRESH_TIMER, encoding="utf-8")
        _run(
            ["systemd-analyze", "verify", str(runner_unit), str(refresh_unit), str(refresh_timer)],
            timeout=20,
        )
    return {
        "status": "PREFLIGHT_PASS",
        "service": SERVICE,
        "current_image_id": runtime["image_id"],
        "target_image_ids": artifact["image_ids"],
        "current_restart_policy": runtime["restart_policy"],
        "current_pull_policy": source["pull_policy"],
        "active_verification_jobs": inactive_jobs,
        "systemd_reload_pending": systemd["need_daemon_reload"],
        "environment_values_read_or_printed": False,
        "runner_env_modified": False,
        "job_store_modified": False,
        "aws_configuration_modified": False,
        "docker_networking_modified": False,
        "docker_image_ref_preserved": True,
        "systemd_restart_policy_preserved": source["restart"],
    }


def _atomic_write(path: Path, data: bytes, mode: int, group_id: int = 0) -> None:
    parent_info = path.parent.lstat()
    if (
        not stat.S_ISDIR(parent_info.st_mode)
        or stat.S_ISLNK(parent_info.st_mode)
        or parent_info.st_uid != 0
        or parent_info.st_gid != 0
        or stat.S_IMODE(parent_info.st_mode) & 0o022
    ):
        raise PreflightError("atomic_write_parent_unsafe")
    temporary = path.with_name(path.name + ".m1578r-tmp")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_NOFOLLOW", 0), mode)
    try:
        os.fchown(fd, 0, group_id)
        os.fchmod(fd, mode)
        with os.fdopen(fd, "wb", closefd=True) as output:
            fd = -1
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
        directory_fd = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        if fd >= 0:
            os.close(fd)
        temporary.unlink(missing_ok=True)


def _health_check(
    expected_image_id: str,
    restart_policy: str,
    expected_old_mounts: list[object] | None = None,
    expected_old_groups: list[object] | None = None,
    identity_enabled: bool = False,
    expected_old_port_bindings: object | None = None,
) -> bool:
    try:
        if _systemd_value("ActiveState") != "active":
            return False
        runtime = _inspect_running_container()
        if runtime["running"] is not True or runtime["health"] != "healthy":
            return False
        if runtime["image_id"] != expected_image_id or runtime["image_ref"] != IMAGE_REF:
            return False
        if runtime["restart_policy"] != restart_policy:
            return False
        if expected_old_port_bindings is not None and runtime["port_bindings"] != expected_old_port_bindings:
            return False
        mounts = runtime["mounts"]
        if not isinstance(mounts, list):
            return False
        identity_mounts = [
            mount
            for mount in mounts
            if isinstance(mount, dict)
            and mount.get("Type") == "bind"
            and mount.get("Source") == str(IDENTITY_DIRECTORY)
            and mount.get("Destination") == str(IDENTITY_DIRECTORY)
            and mount.get("RW") is False
        ]
        if identity_enabled:
            if len(mounts) != 3 or len(identity_mounts) != 1:
                return False
            groups = runtime["groups"]
            if not isinstance(groups, list) or groups != [*expected_old_groups, str(GROUP_ID)]:
                return False
            _assert_identity_mount_reserved(str(runtime["id"]))
        elif len(identity_mounts) != 0:
            return False
        if expected_old_mounts is not None:
            if identity_enabled:
                old = [mount for mount in mounts if mount not in identity_mounts]
                if old != expected_old_mounts:
                    return False
            elif mounts != expected_old_mounts or runtime["groups"] != expected_old_groups:
                return False
        result = subprocess.run(
            ["docker", "exec", CONTAINER_NAME, "node", "-e", "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))"],
            capture_output=True,
            timeout=8,
            check=False,
        )
        return result.returncode == 0
    except Exception:  # noqa: BLE001 - health check is boolean only
        return False


def _write_backup(unit: bytes, current_runtime: dict[str, object]) -> Path:
    if not BACKUP_ROOT.exists():
        BACKUP_ROOT.mkdir(mode=0o700, parents=True, exist_ok=False)
    root_info = BACKUP_ROOT.lstat()
    if not stat.S_ISDIR(root_info.st_mode) or stat.S_ISLNK(root_info.st_mode) or root_info.st_uid != 0:
        raise PreflightError("backup_directory_unsafe")
    if stat.S_IMODE(root_info.st_mode) & 0o077:
        os.chmod(BACKUP_ROOT, 0o700)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup = BACKUP_ROOT / f"m1578r-host-identity-{stamp}"
    backup.mkdir(mode=0o700)
    os.chown(backup, 0, 0)
    payload = {
        "previousImageId": current_runtime["image_id"],
        "previousMounts": current_runtime["mounts"],
        "previousGroups": current_runtime["groups"],
        "previousPortBindings": current_runtime["port_bindings"],
        "previousRestartPolicy": current_runtime["restart_policy"],
        "service": SERVICE,
        "serviceMode": stat.S_IMODE(SERVICE_PATH.stat().st_mode),
        "previousServiceSha256": hashlib.sha256(unit).hexdigest(),
    }
    (backup / "runner.service").write_bytes(unit)
    (backup / "metadata.json").write_text(json.dumps(payload), encoding="utf-8")
    for path, name in ((HELPER_PATH, "helper.py"), (REFRESH_SERVICE_PATH, "refresh.service"), (REFRESH_TIMER_PATH, "refresh.timer")):
        if path.exists():
            shutil.copy2(path, backup / name)
            payload[name + "_existed"] = True
        else:
            payload[name + "_existed"] = False
    (backup / "metadata.json").write_text(json.dumps(payload, sort_keys=True), encoding="utf-8")
    for child in backup.iterdir():
        os.chown(child, 0, 0)
        os.chmod(child, 0o600)
        child_fd = os.open(child, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        try:
            os.fsync(child_fd)
        finally:
            os.close(child_fd)
    payload["backupFilesSha256"] = {
        child.name: sha256_file(child)
        for child in backup.iterdir()
        if child.name != "metadata.json" and child.is_file() and not child.is_symlink()
    }
    metadata_file = backup / "metadata.json"
    metadata_file.write_text(json.dumps(payload, sort_keys=True), encoding="utf-8")
    os.chown(metadata_file, 0, 0)
    os.chmod(metadata_file, 0o600)
    metadata_fd = os.open(metadata_file, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        os.fsync(metadata_fd)
    finally:
        os.close(metadata_fd)
    directory_fd = os.open(backup, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)
    return backup


def _rollback(
    backup: Path,
    old_mounts: list[object],
    old_groups: list[object],
    restart_policy: str,
    old_image_id: str,
    old_port_bindings: object,
) -> bool:
    try:
        metadata = json.loads((backup / "metadata.json").read_text(encoding="utf-8"))
        _run(["systemctl", "disable", "--now", "auterim-verifier-identity-refresh.timer"], check=False)
        _run(["systemctl", "stop", "auterim-verifier-identity-refresh.service"], check=False)
        _atomic_write(SERVICE_PATH, (backup / "runner.service").read_bytes(), int(metadata["serviceMode"]))
        for path, name in ((HELPER_PATH, "helper.py"), (REFRESH_SERVICE_PATH, "refresh.service"), (REFRESH_TIMER_PATH, "refresh.timer")):
            if metadata.get(name + "_existed"):
                mode = 0o750 if name == "helper.py" else 0o644
                _atomic_write(path, (backup / name).read_bytes(), mode)
            else:
                path.unlink(missing_ok=True)
        _run(["docker", "tag", old_image_id, IMAGE_REF])
        _run(["systemctl", "daemon-reload"])
        _run(["systemctl", "restart", SERVICE], timeout=60)
        try:
            if IDENTITY_DIRECTORY.exists() or IDENTITY_DIRECTORY.is_symlink():
                directory_info = IDENTITY_DIRECTORY.lstat()
                if not stat.S_ISDIR(directory_info.st_mode) or stat.S_ISLNK(directory_info.st_mode):
                    return False
                for child in IDENTITY_DIRECTORY.iterdir():
                    child_info = child.lstat()
                    if (
                        not stat.S_ISREG(child_info.st_mode)
                        or stat.S_ISLNK(child_info.st_mode)
                        or child_info.st_uid != 0
                    ):
                        return False
                    child.unlink()
                IDENTITY_DIRECTORY.rmdir()
        except OSError:
            return False
        return _health_check(
            old_image_id,
            restart_policy,
            old_mounts,
            old_groups,
            expected_old_port_bindings=old_port_bindings,
        )
    except Exception:  # noqa: BLE001 - no command output emitted
        return False


def rollback_from_backup(backup: Path) -> dict[str, object]:
    if os.geteuid() != 0:
        raise PreflightError("root_required")
    try:
        if not backup.is_absolute() or backup.parent != BACKUP_ROOT or backup.is_symlink():
            raise PreflightError("rollback_backup_scope_invalid")
        root_info = BACKUP_ROOT.lstat()
        if (
            not stat.S_ISDIR(root_info.st_mode)
            or stat.S_ISLNK(root_info.st_mode)
            or root_info.st_uid != 0
            or root_info.st_gid != 0
            or stat.S_IMODE(root_info.st_mode) != 0o700
        ):
            raise PreflightError("rollback_backup_permissions_unsafe")
        backup_real = backup
        info = backup_real.lstat()
        if (
            not stat.S_ISDIR(info.st_mode)
            or stat.S_ISLNK(info.st_mode)
            or info.st_uid != 0
            or info.st_gid != 0
            or stat.S_IMODE(info.st_mode) != 0o700
        ):
            raise PreflightError("rollback_backup_permissions_unsafe")
        metadata_path = backup_real / "metadata.json"
        metadata_stat = metadata_path.lstat()
        if (
            not stat.S_ISREG(metadata_stat.st_mode)
            or stat.S_ISLNK(metadata_stat.st_mode)
            or metadata_stat.st_uid != 0
            or metadata_stat.st_gid != 0
            or stat.S_IMODE(metadata_stat.st_mode) != 0o600
        ):
            raise PreflightError("rollback_backup_permissions_unsafe")
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        if metadata.get("service") != SERVICE or not metadata.get("deployedServiceSha256"):
            raise PreflightError("rollback_backup_not_deployed")
        backup_hashes = metadata.get("backupFilesSha256")
        if not isinstance(backup_hashes, dict) or "runner.service" not in backup_hashes:
            raise PreflightError("rollback_backup_invalid")
        expected_files = {"runner.service"}
        for filename in ("helper.py", "refresh.service", "refresh.timer"):
            if metadata.get(filename + "_existed"):
                expected_files.add(filename)
        if set(backup_hashes) != expected_files:
            raise PreflightError("rollback_backup_invalid")
        for filename in expected_files:
            candidate = backup_real / filename
            child_stat = candidate.lstat()
            if (
                not stat.S_ISREG(child_stat.st_mode)
                or stat.S_ISLNK(child_stat.st_mode)
                or child_stat.st_uid != 0
                or child_stat.st_gid != 0
                or stat.S_IMODE(child_stat.st_mode) != 0o600
            ):
                raise PreflightError("rollback_backup_permissions_unsafe")
            if sha256_file(candidate) != backup_hashes.get(filename):
                raise PreflightError("rollback_backup_integrity_failed")
        if sha256_file(backup_real / "runner.service") != metadata.get("previousServiceSha256"):
            raise PreflightError("rollback_backup_integrity_failed")
        if sha256_file(SERVICE_PATH) != metadata["deployedServiceSha256"]:
            raise PreflightError("runner_service_changed_since_release")
        deployed_image_id = str(metadata["deployedImageId"])
        if deployed_image_id not in IMAGE_IDS:
            raise PreflightError("runner_image_changed_since_release")
        current_image_id = _run(["docker", "image", "inspect", "--format", "{{.Id}}", IMAGE_REF])
        if current_image_id != deployed_image_id:
            raise PreflightError("runner_image_changed_since_release")
        auxiliary_hashes = metadata.get("deployedAuxiliarySha256")
        if not isinstance(auxiliary_hashes, dict) or set(auxiliary_hashes) != {
            "helper.py",
            "refresh.service",
            "refresh.timer",
        }:
            raise PreflightError("rollback_backup_invalid")
        auxiliary_paths = {
            "helper.py": HELPER_PATH,
            "refresh.service": REFRESH_SERVICE_PATH,
            "refresh.timer": REFRESH_TIMER_PATH,
        }
        for name, path in auxiliary_paths.items():
            if path.is_symlink() or not path.is_file() or sha256_file(path) != auxiliary_hashes[name]:
                raise PreflightError("runner_auxiliary_changed_since_release")
        old_image_id = str(metadata["previousImageId"])
        _run(["docker", "image", "inspect", "--format", "{{.Id}}", old_image_id])
        old_mounts = metadata["previousMounts"]
        old_groups = metadata["previousGroups"]
        restart_policy = str(metadata["previousRestartPolicy"])
        old_port_bindings = metadata["previousPortBindings"]
        if (
            not isinstance(old_mounts, list)
            or not isinstance(old_groups, list)
            or not isinstance(old_port_bindings, dict)
        ):
            raise PreflightError("rollback_backup_invalid")
        assert_no_active_jobs()
        if not _rollback(
            backup_real, old_mounts, old_groups, restart_policy, old_image_id, old_port_bindings
        ):
            raise PreflightError("automatic_rollback_failed")
        return {
            "status": "ROLLBACK_PASS",
            "service": SERVICE,
            "image_id": old_image_id,
            "health": "healthy",
            "healthz_http_status": 200,
            "runner_env_modified": False,
            "job_store_modified": False,
        }
    except PreflightError:
        raise
    except Exception as exc:  # noqa: BLE001 - fixed safe category
        raise PreflightError("rollback_failed") from exc


def _deploy_staged(image_path: Path, helper_path: Path) -> dict[str, object]:
    checked = preflight(image_path, helper_path)
    old_unit = SERVICE_PATH.read_bytes()
    old_runtime = _inspect_running_container()
    old_mounts = old_runtime["mounts"]
    if not isinstance(old_mounts, list):
        raise PreflightError("current_runner_mount_shape_mismatch")
    old_image_id = str(old_runtime["image_id"])
    old_groups = old_runtime["groups"]
    if not isinstance(old_groups, list):
        raise PreflightError("current_runner_group_config_invalid")
    restart_policy = str(old_runtime["restart_policy"])
    old_port_bindings = old_runtime["port_bindings"]
    if not isinstance(old_port_bindings, dict):
        raise PreflightError("current_runner_port_bindings_invalid")
    backup = _write_backup(old_unit, old_runtime)
    try:
        loaded = _run(["docker", "load", "-i", str(image_path)], timeout=120)
        if IMAGE_REF not in loaded:
            raise PreflightError("loaded_image_identity_mismatch")
        loaded_image_id = _run(["docker", "image", "inspect", "--format", "{{.Id}}", IMAGE_REF])
        if loaded_image_id not in IMAGE_IDS:
            raise PreflightError("loaded_image_identity_mismatch")
        _run(["docker", "tag", loaded_image_id, IMAGE_REF])
        _atomic_write(HELPER_PATH, helper_path.read_bytes(), 0o750)
        _atomic_write(REFRESH_SERVICE_PATH, REFRESH_SERVICE.encode(), 0o644)
        _atomic_write(REFRESH_TIMER_PATH, REFRESH_TIMER.encode(), 0o644)
        if IDENTITY_DIRECTORY.exists() or IDENTITY_DIRECTORY.is_symlink():
            raise PreflightError("identity_runtime_path_already_exists")
        IDENTITY_DIRECTORY.mkdir(mode=0o750, parents=False, exist_ok=False)
        os.chown(IDENTITY_DIRECTORY, 0, GROUP_ID)
        os.chmod(IDENTITY_DIRECTORY, 0o750)
        service_mode = stat.S_IMODE(SERVICE_PATH.stat().st_mode)
        _atomic_write(SERVICE_PATH, patch_unit(old_unit.decode("utf-8")).encode("utf-8"), service_mode)
        _run(["systemd-analyze", "verify", str(SERVICE_PATH)], timeout=20)
        _run(["systemctl", "daemon-reload"])
        _run(["systemctl", "enable", "--now", "auterim-verifier-identity-refresh.timer"])
        refresh = _run(["systemctl", "start", "auterim-verifier-identity-refresh.service"], timeout=12, check=False)
        if _run(["systemctl", "show", "auterim-verifier-identity-refresh.service", "--property=Result", "--value"]) != "success":
            raise PreflightError("host_identity_refresh_failed")
        validate_host_identity_file()
        _run(["systemctl", "restart", SERVICE], timeout=60)
        healthy = False
        for _ in range(20):
            if _health_check(
                loaded_image_id,
                restart_policy,
                old_mounts,
                old_groups,
                identity_enabled=True,
                expected_old_port_bindings=old_port_bindings,
            ):
                healthy = True
                break
            subprocess.run(["sleep", "1"], check=False, capture_output=True)
        if not healthy:
            raise PreflightError("post_restart_health_failed")
        metadata_path = backup / "metadata.json"
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        metadata["deployedImageId"] = loaded_image_id
        metadata["deployedServiceSha256"] = sha256_file(SERVICE_PATH)
        metadata["deployedAuxiliarySha256"] = {
            "helper.py": sha256_file(HELPER_PATH),
            "refresh.service": sha256_file(REFRESH_SERVICE_PATH),
            "refresh.timer": sha256_file(REFRESH_TIMER_PATH),
        }
        _atomic_write(metadata_path, json.dumps(metadata, sort_keys=True).encode("utf-8"), 0o600)
        return {
            "status": "DEPLOY_PASS",
            "image_id": loaded_image_id,
            "health": "healthy",
            "healthz_http_status": 200,
            "backup_record": backup.name,
            "preflight": checked["status"],
            "runner_environment_modified": False,
            "job_store_modified": False,
            "aws_configuration_modified": False,
            "docker_networking_modified": False,
        }
    except Exception as exc:  # noqa: BLE001 - output is fixed safe category only
        rolled_back = _rollback(
            backup, old_mounts, old_groups, restart_policy, old_image_id, old_port_bindings
        )
        raise PreflightError("deployment_rolled_back" if rolled_back else "automatic_rollback_failed") from exc


def deploy(image_path: Path, helper_path: Path) -> dict[str, object]:
    if os.geteuid() != 0:
        raise PreflightError("root_required")
    staging = Path(tempfile.mkdtemp(prefix="auterim-verifier-release-", dir="/run"))
    try:
        os.chown(staging, 0, 0)
        os.chmod(staging, 0o700)
        staged_image = staging / IMAGE_ARCHIVE_NAME
        staged_helper = staging / Path(HELPER_PATH_VALUE).name
        _stage_input_file(image_path, staged_image, MAX_IMAGE_ARCHIVE_BYTES)
        _stage_input_file(helper_path, staged_helper, 1_000_000)
        return _deploy_staged(staged_image, staged_helper)
    finally:
        shutil.rmtree(staging, ignore_errors=True)


def main(argv: list[str]) -> int:
    if len(argv) == 2 and argv[0] == "--rollback":
        try:
            result = rollback_from_backup(Path(argv[1]))
            print(json.dumps(result, sort_keys=True, separators=(",", ":")))
            return 0
        except PreflightError as exc:
            print(json.dumps({"status": "ABORT", "category": exc.category, "no_unapproved_fallback": True}, separators=(",", ":")))
            return 1
    if len(argv) != 3 or argv[0] not in {"--preflight", "--deploy"}:
        print('{"status":"blocked","category":"invalid_invocation"}')
        return 2
    mode, image_name, helper_name = argv
    try:
        result = preflight(Path(image_name), Path(helper_name)) if mode == "--preflight" else deploy(Path(image_name), Path(helper_name))
        print(json.dumps(result, sort_keys=True, separators=(",", ":")))
        return 0
    except PreflightError as exc:
        print(json.dumps({"status": "ABORT", "category": exc.category, "no_unapproved_fallback": True}, separators=(",", ":")))
        return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
