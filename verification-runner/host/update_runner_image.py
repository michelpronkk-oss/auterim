#!/usr/bin/env python3
"""Fail-closed image-only upgrade for the existing identity-enabled verifier."""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from types import ModuleType
from typing import BinaryIO

SERVICE = "auterim-verification-runner.service"
SERVICE_PATH = Path("/etc/systemd/system/auterim-verification-runner.service")
OLD_IMAGE_REF = "auterim-verification-runner:f03235a2ddf2d59846fd0062ddcd6df614e1ad40"
IMAGE_REF = "auterim-verification-runner:m1578r-self-id-20261019-03"
OLD_IMAGE_IDS = (
    "sha256:5c8e5dacc9aab8f84ad41f8a288decb7effdce183e09a4721335a0c3bd552bd3",
    "sha256:0d439b25ab2b717f5cb2f669ccca112e9ab281a1b32bf645c5abaf4a58c9b04b",
)
IMAGE_IDS = (
    "sha256:86ba0b06d9314a4df98b09fc57ceb185c6584598a8197bba23d78ae446098b7b",
    "sha256:8057869831067a84e653c55cc321b37dbb737892512eed45df743a540532956d",
    "sha256:015a340ef9eaa09ab9e8b7371f75ffe1b9cdf4d2631774c6800128bba89ee993",
)
IMAGE_CONFIG_ID = IMAGE_IDS[2]
IMAGE_ARCHIVE_SHA256 = "484f186c2714d7527fddf95527ae6de34c1843077843c2f54a95607a33381f01"
IMAGE_ARCHIVE_NAME = "auterim-verification-runner-m1578r-self-id-20261019-03.tar"
LEGACY_LIBRARY_SHA256 = "55c2e568ec60b12edd435df42655ba6114654b3a5922101665877f9a38dff59e"
BACKUP_ROOT = Path("/var/backups/auterim-verifier-runner-image")
MAX_ARCHIVE_BYTES = 1_000_000_000
MAX_ARCHIVE_ENTRIES = 50_000
MAX_ARCHIVE_EXPANDED_BYTES = 1_000_000_000
CONTAINER_NAME = "auterim-verification-runner"
EXPECTED_EXECSTOP = "/usr/bin/docker stop --time 20 auterim-verification-runner"
READINESS_BUDGET_SECONDS = 120.0
READINESS_POLL_INTERVAL_SECONDS = 2.0
READINESS_TRANSIENT_CATEGORIES = frozenset(
    {
        "systemd_service_activating",
        "container_observation_pending",
        "docker_health_starting",
        "application_health_endpoint_not_ready",
    }
)
SAFE_READINESS_CATEGORIES = frozenset(
    {
        "systemd_configuration_mismatch",
        "systemd_service_activating",
        "systemd_service_inactive",
        "container_observation_pending",
        "container_identity_mismatch",
        "container_exited",
        "container_state_invalid",
        "container_configuration_mismatch",
        "image_identity_mismatch",
        "mount_validation_failed",
        "identity_attestation_failed",
        "docker_health_starting",
        "container_unhealthy",
        "container_health_unavailable",
        "application_health_endpoint_not_ready",
        "health_probe_unavailable",
        "readiness_observation_unavailable",
        "readiness_timeout",
    }
)
SAFE_OPERATION_CATEGORIES = frozenset(
    {
        "docker_image_load_failed",
        "loaded_image_id_mismatch",
        "operator_command_unavailable",
        "operator_command_failed",
        "atomic_write_parent_unsafe",
        "deployment_operation_failed",
        "rollback_operation_failed",
        "operation_failed",
    }
)


class UpgradeError(Exception):
    def __init__(
        self,
        category: str,
        *,
        cause_category: str | None = None,
        cause_detail_category: str | None = None,
        rollback: str | None = None,
        rollback_cause_category: str | None = None,
        rollback_detail_category: str | None = None,
    ):
        super().__init__(category)
        self.category = category
        self.cause_category = cause_category
        self.cause_detail_category = cause_detail_category
        self.rollback = rollback
        self.rollback_cause_category = rollback_cause_category
        self.rollback_detail_category = rollback_detail_category


@dataclass(frozen=True)
class ReadinessObservation:
    ready: bool
    category: str
    retryable: bool = False


def _safe_cause_category(value: str | None, fallback: str) -> str:
    if isinstance(value, str) and (
        value in SAFE_READINESS_CATEGORIES or value in SAFE_OPERATION_CATEGORIES
    ):
        return value
    return fallback


_legacy_cache: ModuleType | None = None


def _load_legacy() -> ModuleType:
    """Load only the reviewed, pinned parser from the same release bundle."""
    global _legacy_cache
    if _legacy_cache is not None:
        return _legacy_cache
    path = Path(__file__).resolve().with_name("deploy_identity_handoff.py")
    try:
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode):
            raise UpgradeError("pinned_host_library_unsafe")
        source = path.read_bytes()
        if len(source) > 1_000_000 or hashlib.sha256(source).hexdigest() != LEGACY_LIBRARY_SHA256:
            raise UpgradeError("pinned_host_library_mismatch")
        module = ModuleType("m1578r_pinned_deploy_identity_handoff")
        module.__file__ = str(path)
        exec(compile(source, str(path), "exec"), module.__dict__)
        _legacy_cache = module
        return module
    except UpgradeError:
        raise
    except Exception as exc:  # noqa: BLE001 - safe category only
        raise UpgradeError("pinned_host_library_unavailable") from exc


def _sha256_stream(stream: BinaryIO) -> str:
    digest = hashlib.sha256()
    for chunk in iter(lambda: stream.read(1024 * 1024), b""):
        digest.update(chunk)
    return digest.hexdigest()


def _open_regular(path: Path, max_bytes: int) -> tuple[int, os.stat_result]:
    try:
        before = path.lstat()
        if (
            not stat.S_ISREG(before.st_mode)
            or stat.S_ISLNK(before.st_mode)
            or before.st_size < 1
            or before.st_size > max_bytes
        ):
            raise UpgradeError("artifact_file_unsafe")
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        after = os.fstat(fd)
        if (
            not stat.S_ISREG(after.st_mode)
            or (before.st_dev, before.st_ino, before.st_size)
            != (after.st_dev, after.st_ino, after.st_size)
        ):
            os.close(fd)
            raise UpgradeError("artifact_file_changed")
        return fd, after
    except UpgradeError:
        raise
    except Exception as exc:  # noqa: BLE001 - safe category only
        raise UpgradeError("artifact_file_unavailable") from exc


def _validate_embedded_deployment_image_ref(
    archive: tarfile.TarFile,
    manifest_entry: dict[str, object],
    by_name: dict[str, tarfile.TarInfo],
) -> None:
    layers = manifest_entry.get("Layers")
    if not isinstance(layers, list) or not layers or len(layers) > 128:
        raise UpgradeError("image_archive_layers_invalid")

    effective_ref: str | None = None
    nested_entry_count = 0
    contracts_path = PurePosixPath("opt/auterim-runner/contracts.ts")
    contracts_parent = contracts_path.parent
    for layer_name in layers:
        if not isinstance(layer_name, str):
            raise UpgradeError("image_archive_layers_invalid")
        layer_member = by_name.get(layer_name)
        if layer_member is None or not layer_member.isfile() or layer_member.size < 1:
            raise UpgradeError("image_archive_layer_invalid")
        layer_stream = archive.extractfile(layer_member)
        if layer_stream is None:
            raise UpgradeError("image_archive_layer_invalid")
        try:
            with tarfile.open(fileobj=layer_stream, mode="r|*") as layer:
                contracts_seen_in_layer = False
                for member in layer:
                    nested_entry_count += 1
                    if nested_entry_count > MAX_ARCHIVE_ENTRIES:
                        raise UpgradeError("image_archive_layer_entry_limit_exceeded")
                    member_path = PurePosixPath(member.name)
                    parts = member_path.parts
                    if member_path.is_absolute() or ".." in parts:
                        continue
                    if member_path == contracts_parent / ".wh..wh..opq":
                        effective_ref = None
                    elif member_path == PurePosixPath("opt/.wh.auterim-runner"):
                        effective_ref = None
                    elif member_path == contracts_parent / ".wh.contracts.ts":
                        effective_ref = None
                    elif member_path == contracts_path:
                        if (
                            contracts_seen_in_layer
                            or not member.isfile()
                            or member.size > 1_000_000
                        ):
                            raise UpgradeError("image_archive_embedded_contract_invalid")
                        contracts_seen_in_layer = True
                        contract_stream = layer.extractfile(member)
                        if contract_stream is None:
                            raise UpgradeError("image_archive_embedded_contract_invalid")
                        source = contract_stream.read(1_000_001)
                        if len(source) != member.size or len(source) > 1_000_000:
                            raise UpgradeError("image_archive_embedded_contract_invalid")
                        try:
                            text = source.decode("utf-8")
                        except UnicodeDecodeError as exc:
                            raise UpgradeError("image_archive_embedded_contract_invalid") from exc
                        matches = re.findall(
                            r"(?m)^\s*export\s+const\s+VERIFICATION_RUNNER_DEPLOYMENT_IMAGE_REF\s*=\s*"
                            r"['\"]([^'\"\r\n]+)['\"]\s*;?\s*$",
                            text,
                        )
                        if len(matches) != 1:
                            raise UpgradeError("image_archive_embedded_contract_invalid")
                        effective_ref = matches[0]
        except UpgradeError:
            raise
        except Exception as exc:  # noqa: BLE001 - image archive detail is never emitted
            raise UpgradeError("image_archive_layer_invalid") from exc

    if effective_ref is None:
        raise UpgradeError("image_archive_embedded_contract_missing")
    if effective_ref != IMAGE_REF:
        raise UpgradeError("image_archive_embedded_image_ref_mismatch")


def validate_archive(path: Path) -> dict[str, str | int]:
    fd, info = _open_regular(path, MAX_ARCHIVE_BYTES)
    try:
        with os.fdopen(fd, "rb", closefd=False) as source:
            digest = _sha256_stream(source)
            if digest != IMAGE_ARCHIVE_SHA256:
                raise UpgradeError("image_archive_fingerprint_mismatch")
            source.seek(0)
            try:
                with tarfile.open(fileobj=source, mode="r:") as archive:
                    members = archive.getmembers()
                    if not members or len(members) > MAX_ARCHIVE_ENTRIES:
                        raise UpgradeError("image_archive_shape_invalid")
                    expanded = 0
                    by_name: dict[str, tarfile.TarInfo] = {}
                    for member in members:
                        if (
                            member.name.startswith("/")
                            or ".." in Path(member.name).parts
                            or member.name in by_name
                            or (not member.isfile() and not member.isdir())
                            or member.size < 0
                            or (member.isdir() and member.size != 0)
                        ):
                            raise UpgradeError("image_archive_entry_unsafe")
                        expanded += member.size
                        if expanded > MAX_ARCHIVE_EXPANDED_BYTES:
                            raise UpgradeError("image_archive_expanded_size_exceeded")
                        by_name[member.name] = member
                    manifest_member = by_name.get("manifest.json")
                    if manifest_member is None or manifest_member.size > 64 * 1024:
                        raise UpgradeError("image_archive_manifest_invalid")
                    manifest_stream = archive.extractfile(manifest_member)
                    if manifest_stream is None:
                        raise UpgradeError("image_archive_manifest_invalid")
                    manifest = json.loads(manifest_stream.read(64 * 1024 + 1))
                    if (
                        not isinstance(manifest, list)
                        or len(manifest) != 1
                        or not isinstance(manifest[0], dict)
                        or manifest[0].get("RepoTags") != [IMAGE_REF]
                    ):
                        raise UpgradeError("image_archive_tag_mismatch")
                    config_path = manifest[0].get("Config")
                    match = re.fullmatch(r"blobs/sha256/([a-f0-9]{64})", str(config_path))
                    config_member = by_name.get(str(config_path))
                    if (
                        not match
                        or match.group(1) != IMAGE_CONFIG_ID.removeprefix("sha256:")
                        or config_member is None
                        or config_member.size > 4 * 1024 * 1024
                    ):
                        raise UpgradeError("image_archive_config_invalid")
                    config_stream = archive.extractfile(config_member)
                    if config_stream is None:
                        raise UpgradeError("image_archive_config_invalid")
                    config = config_stream.read(4 * 1024 * 1024 + 1)
                    if hashlib.sha256(config).hexdigest() != match.group(1):
                        raise UpgradeError("image_archive_config_fingerprint_mismatch")
                    _validate_embedded_deployment_image_ref(archive, manifest[0], by_name)
            except UpgradeError:
                raise
            except Exception as exc:  # noqa: BLE001 - safe category only
                raise UpgradeError("image_archive_invalid") from exc
            source.seek(0)
            if _sha256_stream(source) != digest:
                raise UpgradeError("artifact_file_changed")
            after = os.fstat(source.fileno())
        if (after.st_dev, after.st_ino, after.st_size) != (info.st_dev, info.st_ino, info.st_size):
            raise UpgradeError("artifact_file_changed")
        return {
            "archive_sha256": digest,
            "image_ref": IMAGE_REF,
            "image_config_id": IMAGE_CONFIG_ID,
            "image_ids": list(IMAGE_IDS),
            "archive_bytes": info.st_size,
        }
    finally:
        try:
            os.close(fd)
        except OSError:
            pass


def _systemd_properties(legacy: ModuleType, unit_info: dict[str, object]) -> dict[str, str]:
    names = (
        "NeedDaemonReload",
        "FragmentPath",
        "DropInPaths",
        "EnvironmentFiles",
        "ActiveState",
        "Restart",
    )
    values = {name: legacy._systemd_value(name) for name in names}
    if values["NeedDaemonReload"].lower() != "no":
        raise UpgradeError("systemd_unit_reload_pending")
    if values["FragmentPath"] != str(SERVICE_PATH) or values["DropInPaths"]:
        raise UpgradeError("systemd_effective_unit_mismatch")
    if values["ActiveState"] != "active":
        raise UpgradeError("runner_service_inactive")
    if not re.fullmatch(
        r"\{?/etc/auterim-verifier/runner\.env(?: \(ignore_errors=(?:yes|no)\))?\}?",
        values["EnvironmentFiles"],
    ):
        raise UpgradeError("systemd_effective_environment_mismatch")
    if values["Restart"] != unit_info["restart"]:
        raise UpgradeError("systemd_restart_policy_mismatch")
    return values


def _legacy_validate_unit(legacy: ModuleType, unit_text: str) -> dict[str, object]:
    """Use the pinned parser while translating only this release's old image token."""
    if unit_text.count(OLD_IMAGE_REF) != 1 or IMAGE_REF in unit_text:
        raise UpgradeError("systemd_image_token_not_unique")
    legacy_text = unit_text.replace(OLD_IMAGE_REF, legacy.IMAGE_REF, 1)
    try:
        return legacy.validate_unit(legacy_text, allow_identity_mount=True)
    except UpgradeError:
        raise
    except Exception as exc:  # noqa: BLE001 - parser text is never emitted
        parser_category = getattr(exc, "category", None)
        if isinstance(parser_category, str) and re.fullmatch(
            r"[a-z0-9_]{1,80}", parser_category
        ):
            raise UpgradeError(parser_category) from exc
        raise UpgradeError("systemd_configuration_mismatch") from exc


def _assert_target_image_ref_unused() -> None:
    existing = _run(
        [
            "docker",
            "image",
            "ls",
            "--filter",
            f"reference={IMAGE_REF}",
            "--format",
            "{{.Repository}}:{{.Tag}}",
        ]
    )
    if existing.splitlines():
        raise UpgradeError("target_image_ref_already_present")


def _validate_mounts(mounts: object, identity_dir: str) -> None:
    expected = {
        ("/var/run/docker.sock", "/var/run/docker.sock", True),
        ("/srv/auterim-runner", "/srv/auterim-runner", True),
        (identity_dir, identity_dir, False),
    }
    if not isinstance(mounts, list) or len(mounts) != len(expected):
        raise UpgradeError("runner_mount_shape_mismatch")
    actual = set()
    for mount in mounts:
        if not isinstance(mount, dict) or mount.get("Type") != "bind":
            raise UpgradeError("runner_mount_shape_mismatch")
        actual.add((mount.get("Source"), mount.get("Destination"), mount.get("RW")))
    if actual != expected:
        raise UpgradeError("runner_mount_identity_mismatch")


def _validate_groups(groups: object, group_id: int) -> None:
    if (
        not isinstance(groups, list)
        or len(groups) != 2
        or not str(groups[0]).isdigit()
        or int(groups[0]) <= 0
        or str(groups[1]) != str(group_id)
    ):
        raise UpgradeError("runner_group_handoff_mismatch")


def _read_unit(legacy: ModuleType) -> tuple[bytes, str, dict[str, object]]:
    try:
        unit_stat = SERVICE_PATH.lstat()
        if (
            not stat.S_ISREG(unit_stat.st_mode)
            or stat.S_ISLNK(unit_stat.st_mode)
            or unit_stat.st_uid != 0
            or unit_stat.st_gid != 0
            or stat.S_IMODE(unit_stat.st_mode) not in {0o644, 0o640}
            or unit_stat.st_size > 256 * 1024
        ):
            raise UpgradeError("systemd_unit_permissions_unsafe")
        for parent in (SERVICE_PATH.parent, legacy.HELPER_PATH.parent):
            parent_stat = parent.lstat()
            if (
                not stat.S_ISDIR(parent_stat.st_mode)
                or stat.S_ISLNK(parent_stat.st_mode)
                or parent_stat.st_uid != 0
                or parent_stat.st_gid != 0
                or stat.S_IMODE(parent_stat.st_mode) & 0o022
            ):
                raise UpgradeError("systemd_parent_directory_unsafe")
        raw = SERVICE_PATH.read_bytes()
        unit_text = raw.decode("utf-8")
        parsed = _legacy_validate_unit(legacy, unit_text)
        directives = legacy._service_directives(unit_text)
        stops = [item[2] for item in directives.get("ExecStop", [])]
        if stops != [EXPECTED_EXECSTOP]:
            raise UpgradeError("systemd_execstop_mismatch")
        if parsed["restart"] != "always":
            raise UpgradeError("systemd_restart_policy_unsupported")
        return raw, unit_text, parsed
    except UpgradeError:
        raise
    except Exception as exc:  # noqa: BLE001 - safe category only
        raise UpgradeError("systemd_unit_unavailable") from exc


def _validate_environment_file(legacy: ModuleType) -> None:
    path = Path(legacy.ENV_PATH)
    try:
        info = path.lstat()
        mode = stat.S_IMODE(info.st_mode)
        if (
            not stat.S_ISREG(info.st_mode)
            or stat.S_ISLNK(info.st_mode)
            or info.st_uid != 0
            or mode not in {0o600, 0o640}
            or (mode == 0o640 and info.st_gid != 0)
        ):
            raise UpgradeError("runner_environment_file_permissions_unsafe")
    except UpgradeError:
        raise
    except Exception as exc:  # noqa: BLE001 - safe category only
        raise UpgradeError("runner_environment_file_unavailable") from exc


def _validate_identity_handoff(legacy: ModuleType) -> None:
    expected_files = (
        (legacy.HELPER_PATH, 0o750, legacy.HELPER_SHA256, None),
        (legacy.REFRESH_SERVICE_PATH, 0o644, None, legacy.REFRESH_SERVICE.encode("utf-8")),
        (legacy.REFRESH_TIMER_PATH, 0o644, None, legacy.REFRESH_TIMER.encode("utf-8")),
    )
    try:
        for path, expected_mode, expected_digest, expected_bytes in expected_files:
            info = path.lstat()
            if (
                not stat.S_ISREG(info.st_mode)
                or stat.S_ISLNK(info.st_mode)
                or info.st_uid != 0
                or info.st_gid != 0
                or stat.S_IMODE(info.st_mode) != expected_mode
                or info.st_size > 1_000_000
            ):
                raise UpgradeError("identity_handoff_file_unsafe")
            content = path.read_bytes()
            if expected_digest is not None and hashlib.sha256(content).hexdigest() != expected_digest:
                raise UpgradeError("identity_refresh_helper_fingerprint_mismatch")
            if expected_bytes is not None and content != expected_bytes:
                raise UpgradeError("identity_refresh_unit_mismatch")
        if _run(["systemctl", "is-active", legacy.REFRESH_TIMER_PATH.name]) != "active":
            raise UpgradeError("identity_refresh_timer_inactive")
        if _run(["systemctl", "is-enabled", legacy.REFRESH_TIMER_PATH.name]) != "enabled":
            raise UpgradeError("identity_refresh_timer_disabled")
        if (
            _run(["systemctl", "show", legacy.REFRESH_SERVICE_PATH.name, "--property=Result", "--value"])
            != "success"
            or _run(
                [
                    "systemctl",
                    "show",
                    legacy.REFRESH_SERVICE_PATH.name,
                    "--property=ExecMainStatus",
                    "--value",
                ]
            )
            != "0"
        ):
            raise UpgradeError("identity_refresh_service_not_successful")
    except UpgradeError:
        raise
    except Exception as exc:  # noqa: BLE001 - no file content or system output emitted
        raise UpgradeError("identity_handoff_state_unavailable") from exc


def _validate_runtime(legacy: ModuleType, unit_info: dict[str, object]) -> dict[str, object]:
    runtime = legacy._inspect_running_container()
    if (
        runtime.get("running") is not True
        or runtime.get("health") != "healthy"
        or runtime.get("image_ref") != OLD_IMAGE_REF
        or runtime.get("image_id") not in OLD_IMAGE_IDS
        or not isinstance(runtime.get("restart_policy"), str)
    ):
        raise UpgradeError("current_runner_not_healthy_or_expected")
    _validate_mounts(runtime.get("mounts"), legacy.IDENTITY_DIRECTORY_VALUE)
    _validate_groups(runtime.get("groups"), legacy.GROUP_ID)
    command = unit_info["command"]
    try:
        publish_value = command[command.index("--publish") + 1]
    except (ValueError, IndexError) as exc:
        raise UpgradeError("systemd_publish_binding_unsafe") from exc
    if not legacy.publish_binding_matches_runtime(
        legacy.parse_publish_binding(publish_value), runtime.get("port_bindings")
    ):
        raise UpgradeError("runner_publish_binding_mismatch")
    legacy._assert_identity_mount_reserved(str(runtime["id"]))
    return runtime


def _patch_unit(unit_text: str) -> str:
    legacy = _load_legacy()
    parsed = _legacy_validate_unit(legacy, unit_text)
    marker = f" {OLD_IMAGE_REF}'"
    if unit_text.count(marker) != 1 or IMAGE_REF in unit_text:
        raise UpgradeError("systemd_image_token_not_unique")
    updated = unit_text.replace(marker, f" {IMAGE_REF}'", 1)
    if updated.replace(IMAGE_REF, OLD_IMAGE_REF, 1) != unit_text:
        raise UpgradeError("systemd_candidate_changed_unrelated_text")
    restored = updated.replace(IMAGE_REF, OLD_IMAGE_REF, 1)
    reparsed = _legacy_validate_unit(legacy, restored)
    if parsed["command"] != reparsed["command"]:
        raise UpgradeError("systemd_candidate_semantics_mismatch")
    return updated


def preflight(archive_path: Path) -> dict[str, object]:
    if not hasattr(os, "geteuid") or os.geteuid() != 0:
        raise UpgradeError("root_required")
    legacy = _load_legacy()
    _validate_environment_file(legacy)
    _, unit_text, unit_info = _read_unit(legacy)
    systemd = _systemd_properties(legacy, unit_info)
    _validate_identity_handoff(legacy)
    runtime = _validate_runtime(legacy, unit_info)
    legacy.validate_host_identity_file()
    active_jobs = legacy.assert_no_active_jobs()
    _assert_target_image_ref_unused()
    artifact = validate_archive(archive_path)
    _patch_unit(unit_text)
    return {
        "status": "PREFLIGHT_PASS",
        "service": SERVICE,
        "current_image_id": runtime["image_id"],
        "current_image_ref": runtime["image_ref"],
        "systemd_restart_policy": unit_info["restart"],
        "docker_restart_policy": runtime["restart_policy"],
        "target_image_ref": IMAGE_REF,
        "target_image_ids": IMAGE_IDS,
        "archive_sha256": artifact["archive_sha256"],
        "active_verification_jobs": active_jobs,
        "systemd_reload_pending": systemd["NeedDaemonReload"],
        "identity_handoff": "verified",
        "environment_values_read_or_printed": False,
        "runner_env_modified": False,
        "job_store_modified": False,
        "aws_configuration_modified": False,
        "docker_networking_modified": False,
        "only_service_image_token_changes": True,
    }


def _atomic_write(path: Path, data: bytes, mode: int, uid: int = 0, gid: int = 0) -> None:
    parent = path.parent.lstat()
    if (
        not stat.S_ISDIR(parent.st_mode)
        or stat.S_ISLNK(parent.st_mode)
        or parent.st_uid != 0
        or parent.st_gid != 0
        or stat.S_IMODE(parent.st_mode) & 0o022
    ):
        raise UpgradeError("atomic_write_parent_unsafe")
    temporary = path.with_name(path.name + ".m1578r-tmp")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), mode)
    try:
        os.fchown(fd, uid, gid)
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


def _run(args: list[str], *, timeout: int = 30, check: bool = True) -> str:
    try:
        result = subprocess.run(args, check=False, capture_output=True, text=True, timeout=timeout)
    except Exception as exc:  # noqa: BLE001 - raw output is never emitted
        raise UpgradeError("operator_command_unavailable") from exc
    if check and result.returncode != 0:
        raise UpgradeError("operator_command_failed")
    return result.stdout.strip()


def _docker_load(path: Path) -> None:
    try:
        with path.open("rb") as archive:
            result = subprocess.run(
                ["docker", "load"], stdin=archive, capture_output=True, text=True, timeout=180
            )
        if result.returncode != 0:
            raise UpgradeError("docker_image_load_failed")
    except UpgradeError:
        raise
    except Exception as exc:  # noqa: BLE001 - output is not emitted
        raise UpgradeError("docker_image_load_failed") from exc


def _readiness_command(args: list[str], deadline: float) -> str:
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise UpgradeError("readiness_observation_timeout")
    try:
        result = subprocess.run(
            args,
            check=False,
            capture_output=True,
            text=True,
            timeout=remaining,
        )
    except subprocess.TimeoutExpired as exc:
        raise UpgradeError("readiness_observation_timeout") from exc
    except Exception as exc:  # noqa: BLE001 - command details are never emitted
        raise UpgradeError("readiness_observation_unavailable") from exc
    if result.returncode != 0:
        raise UpgradeError("readiness_observation_unavailable")
    return result.stdout.strip()


def _readiness_container(deadline: float) -> dict[str, object] | ReadinessObservation:
    ids_output = _readiness_command(
        [
            "docker",
            "ps",
            "--all",
            "--quiet",
            "--no-trunc",
            "--filter",
            f"name=^/{CONTAINER_NAME}$",
        ],
        deadline,
    )
    container_ids = [value for value in ids_output.splitlines() if value]
    if not container_ids:
        return ReadinessObservation(False, "container_observation_pending", True)
    if len(container_ids) != 1 or not re.fullmatch(r"[0-9a-f]{12,64}", container_ids[0]):
        return ReadinessObservation(False, "container_identity_mismatch")

    template = (
        "{{.Id}}|{{.Image}}|{{.Config.Image}}|{{.State.Running}}|"
        "{{.State.Health.Status}}|{{.HostConfig.RestartPolicy.Name}}|"
        "{{json .Mounts}}|{{json .HostConfig.GroupAdd}}|{{json .HostConfig.PortBindings}}"
    )
    output = _readiness_command(
        ["docker", "inspect", "--format", template, container_ids[0]],
        deadline,
    )
    try:
        values = output.split("|", 8)
        if len(values) != 9 or values[0] != container_ids[0]:
            raise ValueError()
        mounts = json.loads(values[6])
        groups = json.loads(values[7])
        port_bindings = json.loads(values[8])
        if not isinstance(mounts, list) or not isinstance(groups, list) or not isinstance(port_bindings, dict):
            raise ValueError()
    except Exception as exc:  # noqa: BLE001 - only a safe category escapes
        raise UpgradeError("container_state_invalid") from exc
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


def _validate_identity_mount_bounded(
    identity_directory: str,
    expected_container_id: str,
    deadline: float,
) -> None:
    container_ids = [
        value
        for value in _readiness_command(
            ["docker", "ps", "--quiet", "--no-trunc"], deadline
        ).splitlines()
        if value
    ]
    if len(container_ids) > 256:
        raise UpgradeError("mount_validation_failed")
    matches: list[str] = []
    for container_id in container_ids:
        if not re.fullmatch(r"[0-9a-f]{12,64}", container_id):
            raise UpgradeError("mount_validation_failed")
        output = _readiness_command(
            [
                "docker",
                "inspect",
                "--format={{.Id}}|{{json .Mounts}}",
                container_id,
            ],
            deadline,
        )
        try:
            inspected_id, mounts_json = output.split("|", 1)
            mounts = json.loads(mounts_json)
            if not isinstance(mounts, list):
                raise ValueError()
        except Exception as exc:  # noqa: BLE001 - only a safe category escapes
            raise UpgradeError("mount_validation_failed") from exc
        if any(
            isinstance(mount, dict)
            and (
                mount.get("Source") == identity_directory
                or mount.get("Destination") == identity_directory
            )
            for mount in mounts
        ):
            matches.append(inspected_id)
    if matches != [expected_container_id]:
        raise UpgradeError("mount_validation_failed")


def _assert_readiness_unit_path(legacy: ModuleType) -> None:
    try:
        unit_stat = SERVICE_PATH.lstat()
        if (
            not stat.S_ISREG(unit_stat.st_mode)
            or stat.S_ISLNK(unit_stat.st_mode)
            or unit_stat.st_uid != 0
            or unit_stat.st_gid != 0
            or stat.S_IMODE(unit_stat.st_mode) not in {0o644, 0o640}
            or unit_stat.st_size > 256 * 1024
        ):
            raise UpgradeError("systemd_configuration_mismatch")
        for parent in (SERVICE_PATH.parent, legacy.HELPER_PATH.parent):
            parent_stat = parent.lstat()
            if (
                not stat.S_ISDIR(parent_stat.st_mode)
                or stat.S_ISLNK(parent_stat.st_mode)
                or parent_stat.st_uid != 0
                or parent_stat.st_gid != 0
                or stat.S_IMODE(parent_stat.st_mode) & 0o022
            ):
                raise UpgradeError("systemd_configuration_mismatch")
    except UpgradeError:
        raise
    except Exception as exc:  # noqa: BLE001 - path details are never emitted
        raise UpgradeError("systemd_configuration_mismatch") from exc


def _check_readiness(
    image_ref: str,
    image_ids: tuple[str, ...],
    expected: dict[str, object],
    deadline: float,
) -> ReadinessObservation:
    try:
        legacy = _load_legacy()
        _assert_readiness_unit_path(legacy)
        current_text = SERVICE_PATH.read_text(encoding="utf-8")
        if image_ref not in {IMAGE_REF, OLD_IMAGE_REF}:
            return ReadinessObservation(False, "image_identity_mismatch")
        if current_text.count(image_ref) != 1:
            return ReadinessObservation(False, "systemd_configuration_mismatch")
        if image_ref == IMAGE_REF:
            source_text = current_text.replace(IMAGE_REF, OLD_IMAGE_REF, 1)
        else:
            source_text = current_text
        try:
            unit_info = _legacy_validate_unit(legacy, source_text)
        except Exception as exc:  # noqa: BLE001 - parser details are never exposed
            raise UpgradeError("systemd_configuration_mismatch") from exc
        if unit_info.get("restart") != "always":
            return ReadinessObservation(False, "systemd_configuration_mismatch")
        try:
            stops = [
                item[2]
                for item in legacy._service_directives(source_text).get("ExecStop", [])
            ]
        except Exception as exc:  # noqa: BLE001 - parser details are never exposed
            raise UpgradeError("systemd_configuration_mismatch") from exc
        if stops != [EXPECTED_EXECSTOP]:
            return ReadinessObservation(False, "systemd_configuration_mismatch")
        names = (
            "NeedDaemonReload",
            "FragmentPath",
            "DropInPaths",
            "EnvironmentFiles",
            "ActiveState",
            "Restart",
        )
        values = {
            name: _readiness_command(
                ["systemctl", "show", SERVICE, f"--property={name}", "--value"],
                deadline,
            )
            for name in names
        }
        if (
            values["NeedDaemonReload"].lower() != "no"
            or values["FragmentPath"] != str(SERVICE_PATH)
            or values["DropInPaths"]
            or not re.fullmatch(
                r"\{?/etc/auterim-verifier/runner\.env(?: \(ignore_errors=(?:yes|no)\))?\}?",
                values["EnvironmentFiles"],
            )
            or values["Restart"] != unit_info.get("restart")
        ):
            return ReadinessObservation(False, "systemd_configuration_mismatch")
        if values["ActiveState"] == "activating":
            return ReadinessObservation(False, "systemd_service_activating", True)
        if values["ActiveState"] != "active":
            return ReadinessObservation(False, "systemd_service_inactive")

        runtime = _readiness_container(deadline)
        if isinstance(runtime, ReadinessObservation):
            return runtime
        if runtime.get("image_ref") != image_ref or runtime.get("image_id") not in image_ids:
            return ReadinessObservation(False, "image_identity_mismatch")
        if runtime.get("running") is not True:
            return ReadinessObservation(False, "container_exited")
        if (
            runtime.get("restart_policy") != expected.get("restart_policy")
            or runtime.get("port_bindings") != expected.get("port_bindings")
            or runtime.get("groups") != expected.get("groups")
        ):
            return ReadinessObservation(False, "container_configuration_mismatch")
        try:
            _validate_mounts(runtime.get("mounts"), legacy.IDENTITY_DIRECTORY_VALUE)
        except UpgradeError as exc:
            raise UpgradeError("mount_validation_failed") from exc
        _validate_identity_mount_bounded(
            legacy.IDENTITY_DIRECTORY_VALUE, str(runtime["id"]), deadline
        )
        try:
            legacy.validate_host_identity_file()
        except Exception as exc:  # noqa: BLE001 - identity details are never exposed
            raise UpgradeError("identity_attestation_failed") from exc

        health = runtime.get("health")
        if health == "unhealthy":
            return ReadinessObservation(False, "container_unhealthy")
        if health not in {"starting", "healthy"}:
            return ReadinessObservation(False, "container_health_unavailable")
        try:
            result = subprocess.run(
                [
                    "docker",
                    "exec",
                    CONTAINER_NAME,
                    "node",
                    "-e",
                    "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.status===200?0:20)).catch(()=>process.exit(21))",
                ],
                capture_output=True,
                timeout=max(0.001, deadline - time.monotonic()),
                check=False,
            )
        except subprocess.TimeoutExpired as exc:
            raise UpgradeError("readiness_observation_timeout") from exc
        except Exception as exc:  # noqa: BLE001 - command details are never emitted
            raise UpgradeError("readiness_observation_unavailable") from exc
        if result.returncode == 0:
            if health == "starting":
                return ReadinessObservation(False, "docker_health_starting", True)
            return ReadinessObservation(True, "ready")
        if result.returncode in {20, 21}:
            return ReadinessObservation(False, "application_health_endpoint_not_ready", True)
        return ReadinessObservation(False, "health_probe_unavailable")
    except UpgradeError:
        raise
    except Exception as exc:  # noqa: BLE001 - safe readiness categories only
        if exc.__class__.__name__ == "PreflightError":
            category = getattr(exc, "category", "")
            if category in {"runner_mount_shape_mismatch", "runner_mount_identity_mismatch"}:
                return ReadinessObservation(False, "mount_validation_failed")
            if category.startswith("host_identity_file_") or category.startswith("identity_"):
                return ReadinessObservation(False, "identity_attestation_failed")
            if category.startswith("systemd_"):
                return ReadinessObservation(False, "systemd_configuration_mismatch")
        return ReadinessObservation(False, "readiness_observation_unavailable")


def _wait_for_healthy(
    image_ref: str,
    image_ids: tuple[str, ...],
    expected: dict[str, object],
) -> None:
    deadline = time.monotonic() + READINESS_BUDGET_SECONDS
    last_category = "readiness_observation_unavailable"
    while True:
        if time.monotonic() >= deadline:
            raise UpgradeError("readiness_timeout", cause_category=last_category)
        try:
            observation = _check_readiness(image_ref, image_ids, expected, deadline)
        except UpgradeError as exc:
            if exc.category == "readiness_observation_timeout":
                raise UpgradeError("readiness_timeout", cause_category=last_category) from exc
            raise
        if observation.ready:
            return
        if observation.category not in SAFE_READINESS_CATEGORIES:
            raise UpgradeError("readiness_observation_unavailable")
        last_category = observation.category
        if not observation.retryable:
            raise UpgradeError(observation.category)
        if observation.category not in READINESS_TRANSIENT_CATEGORIES:
            raise UpgradeError("readiness_observation_unavailable")
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise UpgradeError("readiness_timeout", cause_category=last_category)
        time.sleep(min(READINESS_POLL_INTERVAL_SECONDS, remaining))


def _write_backup(unit_raw: bytes, runtime: dict[str, object]) -> Path:
    if not BACKUP_ROOT.exists():
        parent_info = BACKUP_ROOT.parent.lstat()
        if (
            not stat.S_ISDIR(parent_info.st_mode)
            or stat.S_ISLNK(parent_info.st_mode)
            or parent_info.st_uid != 0
            or parent_info.st_gid != 0
            or stat.S_IMODE(parent_info.st_mode) & 0o022
        ):
            raise UpgradeError("backup_parent_unsafe")
        BACKUP_ROOT.mkdir(mode=0o700, parents=True, exist_ok=False)
    root_info = BACKUP_ROOT.lstat()
    if (
        not stat.S_ISDIR(root_info.st_mode)
        or stat.S_ISLNK(root_info.st_mode)
        or root_info.st_uid != 0
        or root_info.st_gid != 0
        or stat.S_IMODE(root_info.st_mode) & 0o077
    ):
        raise UpgradeError("backup_directory_unsafe")
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    backup = BACKUP_ROOT / f"m1578r-runner-image-{stamp}"
    backup.mkdir(mode=0o700)
    os.chown(backup, 0, 0)
    unit_copy = backup / "runner.service"
    _atomic_write(unit_copy, unit_raw, 0o600)
    metadata = {
        "version": 1,
        "service": SERVICE,
        "unitSha256": hashlib.sha256(unit_raw).hexdigest(),
        "previousImageId": runtime["image_id"],
        "previousImageRef": runtime["image_ref"],
        "previousDockerRestartPolicy": runtime["restart_policy"],
        "previousGroups": runtime["groups"],
        "previousPortBindings": runtime["port_bindings"],
        "targetImageRef": IMAGE_REF,
        "targetImageIds": list(IMAGE_IDS),
        "createdAt": stamp,
    }
    record = backup / "metadata.json"
    _atomic_write(record, json.dumps(metadata, sort_keys=True, separators=(",", ":")).encode(), 0o600)
    return backup


def _restore_backup(backup: Path) -> dict[str, object]:
    if not hasattr(os, "geteuid") or os.geteuid() != 0:
        raise UpgradeError("root_required")
    legacy = _load_legacy()
    try:
        info = backup.lstat()
        metadata_path = backup / "metadata.json"
        unit_path = backup / "runner.service"
        if (
            not stat.S_ISDIR(info.st_mode)
            or stat.S_ISLNK(info.st_mode)
            or info.st_uid != 0
            or info.st_gid != 0
            or stat.S_IMODE(info.st_mode) != 0o700
            or backup.parent != BACKUP_ROOT
        ):
            raise UpgradeError("rollback_record_unsafe")
        meta_info = metadata_path.lstat()
        unit_info = unit_path.lstat()
        if (
            not stat.S_ISREG(meta_info.st_mode)
            or stat.S_ISLNK(meta_info.st_mode)
            or meta_info.st_uid != 0
            or stat.S_IMODE(meta_info.st_mode) != 0o600
            or meta_info.st_size > 64 * 1024
            or meta_info.st_nlink != 1
            or not stat.S_ISREG(unit_info.st_mode)
            or stat.S_ISLNK(unit_info.st_mode)
            or unit_info.st_uid != 0
            or unit_info.st_gid != 0
            or stat.S_IMODE(unit_info.st_mode) != 0o600
            or unit_info.st_size > 256 * 1024
            or unit_info.st_nlink != 1
        ):
            raise UpgradeError("rollback_record_unsafe")
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        old_unit = unit_path.read_bytes()
        if (
            set(metadata)
            != {
                "version",
                "service",
                "unitSha256",
                "previousImageId",
                "previousImageRef",
                "previousDockerRestartPolicy",
                "previousGroups",
                "previousPortBindings",
                "targetImageRef",
                "targetImageIds",
                "createdAt",
            }
            or metadata["version"] != 1
            or metadata["service"] != SERVICE
            or metadata["previousImageRef"] != OLD_IMAGE_REF
            or metadata["previousImageId"] not in OLD_IMAGE_IDS
            or not isinstance(metadata["previousDockerRestartPolicy"], str)
            or metadata["targetImageRef"] != IMAGE_REF
            or metadata["targetImageIds"] != list(IMAGE_IDS)
            or hashlib.sha256(old_unit).hexdigest() != metadata["unitSha256"]
        ):
            raise UpgradeError("rollback_record_invalid")
        _validate_groups(metadata["previousGroups"], legacy.GROUP_ID)
        if not isinstance(metadata["previousPortBindings"], dict):
            raise UpgradeError("rollback_record_invalid")
        old_text = old_unit.decode("utf-8")
        _legacy_validate_unit(legacy, old_text)
        current_unit = SERVICE_PATH.read_text(encoding="utf-8")
        expected_current_unit = old_text.replace(OLD_IMAGE_REF, IMAGE_REF, 1)
        if current_unit != expected_current_unit:
            raise UpgradeError("rollback_current_unit_unexpected")
        current_runtime = legacy._inspect_running_container()
        if current_runtime.get("image_ref") != IMAGE_REF or current_runtime.get("image_id") not in IMAGE_IDS:
            raise UpgradeError("rollback_current_runner_unexpected")
        _atomic_write(SERVICE_PATH, old_unit, stat.S_IMODE(SERVICE_PATH.stat().st_mode), 0, 0)
        _run(["systemctl", "daemon-reload"])
        _run(["docker", "tag", metadata["previousImageId"], OLD_IMAGE_REF])
        _run(["systemctl", "restart", SERVICE], timeout=60)
        rollback_expectations = {
            "restart_policy": metadata["previousDockerRestartPolicy"],
            "groups": metadata["previousGroups"],
            "port_bindings": metadata["previousPortBindings"],
        }
        try:
            _wait_for_healthy(OLD_IMAGE_REF, OLD_IMAGE_IDS, rollback_expectations)
        except UpgradeError as exc:
            raise UpgradeError(
                "rollback_failed",
                cause_category=_safe_cause_category(
                    exc.category, "rollback_operation_failed"
                ),
                cause_detail_category=_safe_cause_category(exc.cause_category, ""),
            ) from exc
        return {
            "status": "ROLLBACK_PASS",
            "service": SERVICE,
            "restored_image_id": metadata["previousImageId"],
            "backup_record": str(backup),
            "health": "healthy",
            "healthz": 200,
            "systemd_only": True,
            "environment_values_read_or_printed": False,
        }
    except UpgradeError:
        raise
    except Exception as exc:  # noqa: BLE001 - safe category only
        raise UpgradeError("rollback_failed") from exc


def deploy(archive_path: Path) -> dict[str, object]:
    if not hasattr(os, "geteuid") or os.geteuid() != 0:
        raise UpgradeError("root_required")
    stage = Path(tempfile.mkdtemp(prefix="auterim-runner-image-", dir="/run"))
    try:
        os.chown(stage, 0, 0)
        os.chmod(stage, 0o700)
        staged_archive = stage / IMAGE_ARCHIVE_NAME
        legacy = _load_legacy()
        legacy._stage_input_file(archive_path, staged_archive, MAX_ARCHIVE_BYTES)
        gate = preflight(staged_archive)
        old_raw, old_text, unit_info = _read_unit(legacy)
        old_runtime = _validate_runtime(legacy, unit_info)
        backup = _write_backup(old_raw, old_runtime)
        try:
            _assert_target_image_ref_unused()
            _docker_load(staged_archive)
            image_id = _run(["docker", "image", "inspect", "--format", "{{.Id}}", IMAGE_REF])
            if image_id not in IMAGE_IDS:
                raise UpgradeError("loaded_image_id_mismatch")
            updated = _patch_unit(old_text)
            _atomic_write(
                SERVICE_PATH,
                updated.encode("utf-8"),
                stat.S_IMODE(SERVICE_PATH.stat().st_mode),
                0,
                0,
            )
            _run(["systemctl", "daemon-reload"])
            _run(["systemctl", "restart", SERVICE], timeout=60)
            _wait_for_healthy(IMAGE_REF, IMAGE_IDS, old_runtime)
            return {
                "status": "DEPLOY_PASS",
                "service": SERVICE,
                "image_ref": IMAGE_REF,
                "image_id": image_id,
                "image_ids": list(IMAGE_IDS),
                "archive_sha256": gate["archive_sha256"],
                "backup_record": str(backup),
                "health": "healthy",
                "healthz": 200,
                "unit_changed_only_image_token": True,
                "runner_env_modified": False,
                "job_store_modified": False,
                "aws_configuration_modified": False,
                "docker_networking_modified": False,
            }
        except Exception as exc:
            rollback_ok = False
            rollback_cause_category: str | None = None
            rollback_detail_category: str | None = None
            try:
                try:
                    current_unit = SERVICE_PATH.read_bytes()
                except OSError:
                    current_unit = None
                if current_unit != old_raw:
                    _atomic_write(
                        SERVICE_PATH,
                        old_raw,
                        stat.S_IMODE(SERVICE_PATH.stat().st_mode),
                        0,
                        0,
                    )
                    _run(["systemctl", "daemon-reload"])
                    _run(["docker", "tag", old_runtime["image_id"], OLD_IMAGE_REF])
                    _run(["systemctl", "restart", SERVICE], timeout=60)
                _wait_for_healthy(OLD_IMAGE_REF, OLD_IMAGE_IDS, old_runtime)
                rollback_ok = True
            except UpgradeError as rollback_exc:
                rollback_cause_category = _safe_cause_category(
                    rollback_exc.category, "rollback_operation_failed"
                )
                rollback_detail_category = _safe_cause_category(
                    rollback_exc.cause_category, ""
                ) or None
            except Exception:  # noqa: BLE001 - raw rollback errors are never emitted
                rollback_cause_category = "rollback_operation_failed"
            if isinstance(exc, UpgradeError):
                category = _safe_cause_category(
                    exc.category, "deployment_operation_failed"
                )
                detail_category = _safe_cause_category(exc.cause_category, "") or None
            else:
                category = "deployment_operation_failed"
                detail_category = None
            raise UpgradeError(
                "deployment_failed",
                cause_category=category,
                cause_detail_category=detail_category,
                rollback="passed" if rollback_ok else "failed",
                rollback_cause_category=rollback_cause_category,
                rollback_detail_category=rollback_detail_category,
            ) from exc
    finally:
        shutil.rmtree(stage, ignore_errors=True)


def main(argv: list[str]) -> int:
    try:
        if len(argv) == 2 and argv[0] == "--rollback":
            result = _restore_backup(Path(argv[1]))
        elif len(argv) == 2 and argv[0] == "--preflight":
            result = preflight(Path(argv[1]))
        elif len(argv) == 2 and argv[0] == "--deploy":
            result = deploy(Path(argv[1]))
        else:
            print('{"status":"ABORT","category":"invalid_invocation","no_unapproved_fallback":true}')
            return 2
        print(json.dumps(result, sort_keys=True, separators=(",", ":")))
        return 0
    except UpgradeError as exc:
        result = {"status": "ABORT", "category": exc.category, "no_unapproved_fallback": True}
        if exc.cause_category is not None:
            result["cause_category"] = _safe_cause_category(
                exc.cause_category, "operation_failed"
            )
        if exc.cause_detail_category is not None:
            detail = _safe_cause_category(exc.cause_detail_category, "")
            if detail:
                result["cause_detail_category"] = detail
        if exc.rollback is not None:
            result["rollback"] = exc.rollback
        if exc.rollback_cause_category is not None:
            result["rollback_cause_category"] = _safe_cause_category(
                exc.rollback_cause_category, "rollback_operation_failed"
            )
        if exc.rollback_detail_category is not None:
            detail = _safe_cause_category(exc.rollback_detail_category, "")
            if detail:
                result["rollback_detail_category"] = detail
        print(
            json.dumps(result, sort_keys=True, separators=(",", ":"))
        )
        return 1
    except Exception:  # noqa: BLE001 - never print raw system/command errors
        print('{"status":"ABORT","category":"internal_failure","no_unapproved_fallback":true}')
        return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
