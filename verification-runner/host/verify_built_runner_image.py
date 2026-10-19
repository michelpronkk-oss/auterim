#!/usr/bin/env python3
"""Inspect the built runner image and pinned archive before release packaging."""

from __future__ import annotations

import argparse
import json
import subprocess
import uuid
from pathlib import Path

import update_runner_image as release


def _docker(args: list[str]) -> str:
    try:
        result = subprocess.run(
            ["docker", *args],
            check=False,
            capture_output=True,
            text=True,
            timeout=60,
        )
    except Exception as exc:  # noqa: BLE001 - subprocess details are not emitted
        raise release.UpgradeError("docker_inspection_unavailable") from exc
    if result.returncode != 0:
        raise release.UpgradeError("docker_inspection_failed")
    return result.stdout.strip()


def inspect_built_image(archive_path: Path) -> dict[str, object]:
    archive = release.validate_archive(archive_path)
    image_id = _docker(
        ["image", "inspect", "--format", "{{.Id}}", release.IMAGE_REF]
    )
    platform = _docker(
        ["image", "inspect", "--format", "{{.Os}}/{{.Architecture}}", release.IMAGE_REF]
    )
    if image_id not in release.IMAGE_IDS or platform != "linux/amd64":
        raise release.UpgradeError("built_image_identity_mismatch")

    probe_name = f"m1578r-image-contract-{uuid.uuid4().hex}"
    created = False
    try:
        _docker(
            [
                "create",
                "--name",
                probe_name,
                "--network",
                "none",
                "--read-only",
                "--cap-drop",
                "ALL",
                "--security-opt",
                "no-new-privileges",
                "--entrypoint",
                "node",
                release.IMAGE_REF,
                "--version",
            ]
        )
        created = True
        inspected = _docker(
            ["inspect", "--format", "{{.Image}}|{{.Config.Image}}", probe_name]
        )
        image_config_id, configured_ref = inspected.split("|", 1)
        if image_config_id not in release.IMAGE_IDS or configured_ref != release.IMAGE_REF:
            raise release.UpgradeError("built_container_identity_mismatch")

        source = (
            'const fs=require("node:fs");'
            'const s=fs.readFileSync("/opt/auterim-runner/contracts.ts","utf8");'
            'const m=s.match(/VERIFICATION_RUNNER_DEPLOYMENT_IMAGE_REF\\s*=\\s*"([^"]+)"/s);'
            'if(!m)process.exit(2);process.stdout.write(m[1]);'
        )
        embedded_ref = _docker(
            [
                "run",
                "--rm",
                "--network",
                "none",
                "--read-only",
                "--cap-drop",
                "ALL",
                "--security-opt",
                "no-new-privileges",
                "--entrypoint",
                "node",
                release.IMAGE_REF,
                "-e",
                source,
            ]
        )
        if embedded_ref != release.IMAGE_REF:
            raise release.UpgradeError("built_image_embedded_ref_mismatch")
        git_version = _docker(
            [
                "run",
                "--rm",
                "--network",
                "none",
                "--read-only",
                "--cap-drop",
                "ALL",
                "--security-opt",
                "no-new-privileges",
                "--entrypoint",
                "git",
                release.IMAGE_REF,
                "--version",
            ]
        )
        if git_version != "git version 2.49.1":
            raise release.UpgradeError("built_image_git_version_mismatch")
    except ValueError as exc:
        raise release.UpgradeError("built_container_identity_invalid") from exc
    finally:
        if created:
            try:
                _docker(["rm", probe_name])
            except release.UpgradeError:
                raise release.UpgradeError("built_image_probe_cleanup_failed")

    return {
        "status": "IMAGE_VALIDATION_PASS",
        "image_ref": release.IMAGE_REF,
        "docker_image_id": image_id,
        "container_image_id": image_config_id,
        "image_config_id": archive["image_config_id"],
        "archive_sha256": archive["archive_sha256"],
        "platform": platform,
        "embedded_deployment_image_ref_matches": True,
        "container_config_image_matches": True,
        "git_version": git_version,
        "secrets_or_environment_values_read": False,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--archive", required=True, type=Path)
    args = parser.parse_args()
    try:
        print(json.dumps(inspect_built_image(args.archive), sort_keys=True, separators=(",", ":")))
        return 0
    except release.UpgradeError as exc:
        print(
            json.dumps(
                {"status": "IMAGE_VALIDATION_ABORT", "category": exc.category},
                sort_keys=True,
                separators=(",", ":"),
            )
        )
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
