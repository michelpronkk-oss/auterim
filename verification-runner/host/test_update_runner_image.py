import hashlib
import io
import json
import os
import re
import stat
import tarfile
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import deploy_identity_handoff as identity
import update_runner_image as upgrade


def identity_enabled_unit():
    base = """[Unit]
Description=Auterim verifier

[Service]
ExecStop=/usr/bin/docker stop --time 20 auterim-verification-runner
EnvironmentFile=/etc/auterim-verifier/runner.env
ExecStart=/bin/sh -lc 'exec docker run \\
    --rm --name auterim-verification-runner \\
    --pull=never \\
    --group-add "$(stat -c %%g /var/run/docker.sock)" \\
    --publish 127.0.0.1:8080:8080 \\
    --mount type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock \\
    --mount type=bind,source=/srv/auterim-runner,target=/srv/auterim-runner \\
    --env FIX_VERIFICATION_RUNNER_AUTH_SECRET \\
    --env FIX_VERIFICATION_RUNNER_WORK_ROOT \\
    --env FIX_DEPENDENCY_CACHE_PUBLIC_KEY \\
    --env NEXT_PUBLIC_SUPABASE_URL \\
    auterim-verification-runner:ac73ed8'
Restart=always
"""
    return identity.patch_unit(base).replace(identity.IMAGE_REF, upgrade.OLD_IMAGE_REF)


def archive_bytes(image_ref, config_id, embedded_image_ref=None):
    config = b'{"architecture":"amd64","os":"linux"}'
    config_digest = hashlib.sha256(config).hexdigest()
    if config_id != "sha256:" + config_digest:
        raise AssertionError("test config identity mismatch")
    config_path = f"blobs/sha256/{config_digest}"
    embedded_ref = image_ref if embedded_image_ref is None else embedded_image_ref
    layer_output = io.BytesIO()
    contract = (
        'export const VERIFICATION_RUNNER_DEPLOYMENT_IMAGE_REF =\n'
        f'  "{embedded_ref}";\n'
    ).encode()
    with tarfile.open(fileobj=layer_output, mode="w:") as layer:
        info = tarfile.TarInfo("opt/auterim-runner/contracts.ts")
        info.size = len(contract)
        layer.addfile(info, io.BytesIO(contract))
    layer_bytes = layer_output.getvalue()
    layer_path = "blobs/sha256/runner-contract-layer"
    manifest = json.dumps(
        [{"Config": config_path, "RepoTags": [image_ref], "Layers": [layer_path]}],
        separators=(",", ":"),
    ).encode()
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w:") as archive:
        for name, content in (
            ("manifest.json", manifest),
            (config_path, config),
            (layer_path, layer_bytes),
        ):
            info = tarfile.TarInfo(name)
            info.size = len(content)
            archive.addfile(info, io.BytesIO(content))
    return output.getvalue(), config_id


class RunnerImagePinTests(unittest.TestCase):
    def test_updater_target_matches_shared_runtime_contract_and_pinned_build_inputs(self):
        contracts_path = Path(__file__).resolve().parents[1] / "contracts.ts"
        contracts = contracts_path.read_text(encoding="utf-8")
        matches = re.findall(
            r"(?m)^\s*export\s+const\s+VERIFICATION_RUNNER_DEPLOYMENT_IMAGE_REF\s*=\s*"
            r"['\"]([^'\"\r\n]+)['\"]\s*;?\s*$",
            contracts,
        )
        self.assertEqual(matches, [upgrade.IMAGE_REF])

        dockerfile = (contracts_path.parent / "Dockerfile").read_text(encoding="utf-8")
        self.assertIn(
            "FROM node:24.8.0-alpine3.22@sha256:"
            "3e843c608bb5232f39ecb2b25e41214b958b0795914707374c8acc28487dea17",
            dockerfile,
        )
        self.assertIn(
            "RUN apk add --no-cache ca-certificates=20260909-r0 docker-cli=28.3.3-r5",
            dockerfile,
        )
        self.assertIn("npm ci --ignore-scripts", dockerfile)

    def test_pin_matches_build_artifact_identity(self):
        self.assertEqual(
            upgrade.IMAGE_REF,
            "auterim-verification-runner:m1578r-self-id-20261019-03",
        )
        self.assertEqual(
            upgrade.OLD_IMAGE_REF,
            "auterim-verification-runner:f03235a2ddf2d59846fd0062ddcd6df614e1ad40",
        )
        self.assertEqual(
            upgrade.OLD_IMAGE_IDS,
            (
                "sha256:5c8e5dacc9aab8f84ad41f8a288decb7effdce183e09a4721335a0c3bd552bd3",
                "sha256:0d439b25ab2b717f5cb2f669ccca112e9ab281a1b32bf645c5abaf4a58c9b04b",
            ),
        )
        self.assertEqual(
            upgrade.IMAGE_IDS,
            (
                "sha256:86ba0b06d9314a4df98b09fc57ceb185c6584598a8197bba23d78ae446098b7b",
                "sha256:8057869831067a84e653c55cc321b37dbb737892512eed45df743a540532956d",
                "sha256:015a340ef9eaa09ab9e8b7371f75ffe1b9cdf4d2631774c6800128bba89ee993",
            ),
        )
        self.assertEqual(upgrade.IMAGE_CONFIG_ID, upgrade.IMAGE_IDS[2])
        self.assertIn(
            "sha256:015a340ef9eaa09ab9e8b7371f75ffe1b9cdf4d2631774c6800128bba89ee993",
            upgrade.IMAGE_IDS,
        )
        self.assertEqual(
            upgrade.IMAGE_ARCHIVE_SHA256,
            "484f186c2714d7527fddf95527ae6de34c1843077843c2f54a95607a33381f01",
        )
        self.assertEqual(len(upgrade.LEGACY_LIBRARY_SHA256), 64)

    def test_image_archive_requires_exact_tag_archive_hash_and_config(self):
        config_id = "sha256:" + hashlib.sha256(
            b'{"architecture":"amd64","os":"linux"}'
        ).hexdigest()
        payload, _ = archive_bytes(upgrade.IMAGE_REF, config_id)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "runner.tar"
            path.write_bytes(payload)
            with (
                patch.object(upgrade, "IMAGE_CONFIG_ID", config_id),
                patch.object(upgrade, "IMAGE_IDS", ("sha256:" + "a" * 64, config_id)),
                patch.object(upgrade, "IMAGE_ARCHIVE_SHA256", hashlib.sha256(payload).hexdigest()),
            ):
                result = upgrade.validate_archive(path)
                self.assertEqual(result["image_config_id"], config_id)
                self.assertEqual(result["archive_sha256"], hashlib.sha256(payload).hexdigest())

    def test_image_archive_rejects_wrong_tag_and_modified_bytes(self):
        config_id = "sha256:" + hashlib.sha256(b'{"architecture":"amd64","os":"linux"}').hexdigest()
        wrong_tag, _ = archive_bytes("auterim-verification-runner:other", config_id)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "runner.tar"
            path.write_bytes(wrong_tag)
            with (
                patch.object(upgrade, "IMAGE_CONFIG_ID", config_id),
                patch.object(
                    upgrade,
                    "IMAGE_ARCHIVE_SHA256",
                    hashlib.sha256(wrong_tag).hexdigest(),
                ),
                self.assertRaisesRegex(upgrade.UpgradeError, "image_archive_tag_mismatch"),
            ):
                upgrade.validate_archive(path)
            path.write_bytes(wrong_tag + b"tampered")
            with patch.object(
                upgrade,
                "IMAGE_ARCHIVE_SHA256",
                hashlib.sha256(wrong_tag).hexdigest(),
            ):
                with self.assertRaisesRegex(
                    upgrade.UpgradeError,
                    "image_archive_fingerprint_mismatch",
                ):
                    upgrade.validate_archive(path)

    def test_image_archive_rejects_embedded_self_identity_mismatch(self):
        config_id = "sha256:" + hashlib.sha256(
            b'{"architecture":"amd64","os":"linux"}'
        ).hexdigest()
        payload, _ = archive_bytes(
            upgrade.IMAGE_REF,
            config_id,
            embedded_image_ref="auterim-verification-runner:ac73ed8",
        )
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "runner.tar"
            path.write_bytes(payload)
            with (
                patch.object(upgrade, "IMAGE_CONFIG_ID", config_id),
                patch.object(upgrade, "IMAGE_ARCHIVE_SHA256", hashlib.sha256(payload).hexdigest()),
                self.assertRaisesRegex(
                    upgrade.UpgradeError,
                    "image_archive_embedded_image_ref_mismatch",
                ),
            ):
                upgrade.validate_archive(path)

    def test_new_image_reference_must_be_absent_before_load(self):
        with patch.object(upgrade, "_run", return_value="") as run:
            upgrade._assert_target_image_ref_unused()
        self.assertIn(
            f"reference={upgrade.IMAGE_REF}",
            run.call_args.args[0],
        )
        with patch.object(upgrade, "_run", return_value=upgrade.IMAGE_REF):
            with self.assertRaisesRegex(
                upgrade.UpgradeError,
                "target_image_ref_already_present",
            ):
                upgrade._assert_target_image_ref_unused()

    def test_read_unit_requires_exact_live_execstop_contract(self):
        legacy = upgrade._load_legacy()
        service_path = Path("C:/m1578-test/systemd/runner.service")
        unit_stat = SimpleNamespace(
            st_mode=stat.S_IFREG | 0o644, st_uid=0, st_gid=0, st_size=100_000
        )
        directory_stat = SimpleNamespace(
            st_mode=stat.S_IFDIR | 0o755, st_uid=0, st_gid=0
        )
        expected_line = "ExecStop=/usr/bin/docker stop --time 20 auterim-verification-runner"

        def read_unit(unit):
            raw = unit.encode("utf-8")

            def fake_lstat(path):
                if path == service_path:
                    return unit_stat
                if path in (service_path.parent, legacy.HELPER_PATH.parent):
                    return directory_stat
                raise AssertionError("unexpected path inspected")

            def fake_read_bytes(path):
                if path == service_path:
                    return raw
                raise AssertionError("unexpected file read")

            with (
                patch.object(upgrade, "SERVICE_PATH", service_path),
                patch.object(Path, "lstat", autospec=True, side_effect=fake_lstat),
                patch.object(Path, "read_bytes", autospec=True, side_effect=fake_read_bytes),
            ):
                return upgrade._read_unit(legacy)

        original = identity_enabled_unit()
        parsed = read_unit(original)
        self.assertEqual(parsed[2]["restart"], "always")

        malformed_units = {
            "ten_seconds": original.replace(
                expected_line, expected_line.replace("--time 20", "--time 10"), 1
            ),
            "unexpected_timeout": original.replace(
                expected_line, expected_line.replace("--time 20", "--time 21"), 1
            ),
            "wrong_executable": original.replace(
                expected_line, expected_line.replace("/usr/bin/docker", "/usr/bin/podman"), 1
            ),
            "extra_argument": original.replace(expected_line, expected_line + " --force", 1),
            "missing": original.replace(expected_line, "", 1),
            "duplicate": original + "\n" + expected_line + "\n",
        }
        for name, malformed in malformed_units.items():
            with self.subTest(name=name):
                with self.assertRaisesRegex(upgrade.UpgradeError, "systemd_execstop_mismatch"):
                    read_unit(malformed)

    def test_systemd_upgrade_changes_only_the_final_image_token(self):
        original = identity_enabled_unit()
        updated = upgrade._patch_unit(original)
        self.assertEqual(updated.count(upgrade.IMAGE_REF), 1)
        self.assertNotIn(upgrade.OLD_IMAGE_REF, updated)
        self.assertEqual(updated.replace(upgrade.IMAGE_REF, upgrade.OLD_IMAGE_REF, 1), original)
        self.assertIn("ExecStartPre=-/usr/bin/systemctl start auterim-verifier-identity-refresh.service", updated)
        self.assertIn("ExecStop=/usr/bin/docker stop --time 20 auterim-verification-runner", updated)
        self.assertIn("Restart=always", updated)

    def test_systemd_upgrade_accepts_only_current_production_image_as_base(self):
        original = identity_enabled_unit()
        self.assertIn(upgrade.OLD_IMAGE_REF, original)
        stale = original.replace(upgrade.OLD_IMAGE_REF, "auterim-verification-runner:ac73ed8")
        with self.assertRaisesRegex(upgrade.UpgradeError, "systemd_image_token_not_unique"):
            upgrade._patch_unit(stale)

    def test_systemd_upgrade_rejects_wrong_identity_mount_handoff(self):
        original = identity_enabled_unit().replace(
            "/run/auterim-verifier-identity,target=/run/auterim-verifier-identity,readonly",
            "/tmp/identity,target=/tmp/identity,readonly",
        )
        with self.assertRaisesRegex(Exception, "runner_job_store_mount_mismatch"):
            upgrade._patch_unit(original)

    def test_systemd_upgrade_rejects_extra_shell_command_or_image_occurrence(self):
        original = identity_enabled_unit()
        malformed = original.replace("exec docker run", "exec docker run; touch /tmp/unsafe")
        with self.assertRaisesRegex(Exception, "systemd_shell_operator_unsupported"):
            upgrade._patch_unit(malformed)
        with self.assertRaisesRegex(upgrade.UpgradeError, "systemd_image_token_not_unique"):
            upgrade._patch_unit(original + f"# {upgrade.IMAGE_REF}\n")

    def test_mount_and_group_contracts_fail_closed(self):
        with self.assertRaisesRegex(upgrade.UpgradeError, "runner_mount_shape_mismatch"):
            upgrade._validate_mounts([], "/run/auterim-verifier-identity")
        with self.assertRaisesRegex(upgrade.UpgradeError, "runner_mount_identity_mismatch"):
            upgrade._validate_mounts(
                [
                    {"Type": "bind", "Source": "/var/run/docker.sock", "Destination": "/var/run/docker.sock", "RW": True},
                    {"Type": "bind", "Source": "/srv/auterim-runner", "Destination": "/srv/auterim-runner", "RW": True},
                    {"Type": "bind", "Source": "/run/auterim-verifier-identity", "Destination": "/run/auterim-verifier-identity", "RW": True},
                ],
                "/run/auterim-verifier-identity",
            )
        with self.assertRaisesRegex(upgrade.UpgradeError, "runner_group_handoff_mismatch"):
            upgrade._validate_groups(["not-a-number", "62000"], 62000)

    def test_effective_systemd_properties_accept_only_expected_runner_configuration(self):
        expected = {
            "NeedDaemonReload": "no",
            "FragmentPath": str(upgrade.SERVICE_PATH),
            "DropInPaths": "",
            "EnvironmentFiles": "{/etc/auterim-verifier/runner.env (ignore_errors=no)}",
            "ActiveState": "active",
            "Restart": "always",
        }
        legacy = SimpleNamespace(_systemd_value=Mock(side_effect=lambda key: expected[key]))
        self.assertEqual(upgrade._systemd_properties(legacy, {"restart": "always"}), expected)
        for key, value, category in (
            ("NeedDaemonReload", "yes", "systemd_unit_reload_pending"),
            ("DropInPaths", "/etc/systemd/system/override.conf", "systemd_effective_unit_mismatch"),
            (
                "EnvironmentFiles",
                "{/etc/auterim-verifier/runner.env (ignore_errors=no) /tmp/other.env}",
                "systemd_effective_environment_mismatch",
            ),
            ("Restart", "on-failure", "systemd_restart_policy_mismatch"),
        ):
            with self.subTest(key=key, value=value):
                altered = {**expected, key: value}
                legacy._systemd_value.side_effect = lambda item, values=altered: values[item]
                with self.assertRaisesRegex(upgrade.UpgradeError, category):
                    upgrade._systemd_properties(legacy, {"restart": "always"})

    def test_container_restart_policy_is_preserved_independently_from_systemd(self):
        legacy = upgrade._load_legacy()
        unit = identity_enabled_unit()
        parsed = upgrade._legacy_validate_unit(legacy, unit)
        runtime = {
            "id": "container-id",
            "image_id": upgrade.OLD_IMAGE_IDS[0],
            "image_ref": upgrade.OLD_IMAGE_REF,
            "running": True,
            "health": "healthy",
            "restart_policy": "",
            "mounts": [
                {"Type": "bind", "Source": "/var/run/docker.sock", "Destination": "/var/run/docker.sock", "RW": True},
                {"Type": "bind", "Source": "/srv/auterim-runner", "Destination": "/srv/auterim-runner", "RW": True},
                {"Type": "bind", "Source": "/run/auterim-verifier-identity", "Destination": "/run/auterim-verifier-identity", "RW": False},
            ],
            "groups": ["999", "62000"],
            "port_bindings": {"8080/tcp": [{"HostIp": "127.0.0.1", "HostPort": "8080"}]},
        }
        with (
            patch.object(legacy, "_inspect_running_container", return_value=runtime),
            patch.object(legacy, "_assert_identity_mount_reserved") as reserved,
        ):
            self.assertEqual(upgrade._validate_runtime(legacy, parsed), runtime)
        reserved.assert_called_once_with("container-id")

    def test_identity_handoff_preflight_checks_pinned_files_timer_and_last_refresh(self):
        helper_bytes = b"reviewed identity helper"
        refresh_service = b"[Service]\nExecStart=/usr/local/bin/auterim-verifier-refresh-identity.py --refresh\n"
        refresh_timer = b"[Timer]\nUnit=auterim-verifier-identity-refresh.service\n"

        def file(path, content, mode):
            return SimpleNamespace(
                lstat=Mock(
                    return_value=SimpleNamespace(
                        st_mode=stat.S_IFREG | mode,
                        st_uid=0,
                        st_gid=0,
                        st_size=len(content),
                    )
                ),
                read_bytes=Mock(return_value=content),
                name=path,
            )

        legacy = SimpleNamespace(
            HELPER_PATH=file("auterim-verifier-refresh-identity.py", helper_bytes, 0o750),
            HELPER_SHA256=hashlib.sha256(helper_bytes).hexdigest(),
            REFRESH_SERVICE_PATH=file("auterim-verifier-identity-refresh.service", refresh_service, 0o644),
            REFRESH_SERVICE=refresh_service.decode(),
            REFRESH_TIMER_PATH=file("auterim-verifier-identity-refresh.timer", refresh_timer, 0o644),
            REFRESH_TIMER=refresh_timer.decode(),
        )
        with patch.object(upgrade, "_run", side_effect=["active", "enabled", "success", "0"]) as run:
            upgrade._validate_identity_handoff(legacy)
        self.assertEqual(run.call_count, 4)

        with patch.object(upgrade, "_run", side_effect=["active", "disabled"]):
            with self.assertRaisesRegex(upgrade.UpgradeError, "identity_refresh_timer_disabled"):
                upgrade._validate_identity_handoff(legacy)

    def test_preflight_is_read_only_and_rechecks_all_runtime_gates(self):
        unit = identity_enabled_unit()
        unit_info = {"command": ["exec", "docker", "run", upgrade.OLD_IMAGE_REF], "restart": "always"}
        runtime = {
            "id": "container-id",
            "image_id": upgrade.OLD_IMAGE_IDS[0],
            "image_ref": upgrade.OLD_IMAGE_REF,
            "running": True,
            "health": "healthy",
            "restart_policy": "always",
            "mounts": [],
            "groups": ["999", "62000"],
            "port_bindings": {},
        }
        archive = {"archive_sha256": upgrade.IMAGE_ARCHIVE_SHA256}
        legacy = SimpleNamespace(
            validate_host_identity_file=Mock(),
            assert_no_active_jobs=Mock(return_value=0),
        )
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "runner.tar"
            path.write_bytes(b"fixture")
            with (
                patch.object(upgrade.os, "geteuid", return_value=0, create=True),
                patch.object(upgrade.os, "chown", return_value=None, create=True),
                patch.object(upgrade, "_load_legacy", return_value=legacy),
                patch.object(upgrade, "_validate_environment_file") as env_check,
                patch.object(upgrade, "_read_unit", return_value=(unit.encode(), unit, unit_info)),
                patch.object(upgrade, "_systemd_properties", return_value={"NeedDaemonReload": "no"}) as sys_check,
                patch.object(upgrade, "_validate_identity_handoff") as identity_check,
                patch.object(upgrade, "_validate_runtime", return_value=runtime) as runtime_check,
                patch.object(upgrade, "_assert_target_image_ref_unused") as unused_ref_check,
                patch.object(upgrade, "validate_archive", return_value=archive) as archive_check,
                patch.object(upgrade, "_patch_unit", return_value=unit),
                patch.object(upgrade, "_run") as run,
                patch.object(upgrade, "_atomic_write") as write,
            ):
                result = upgrade.preflight(path)
            self.assertEqual(result["status"], "PREFLIGHT_PASS")
            self.assertEqual(result["active_verification_jobs"], 0)
            self.assertTrue(result["only_service_image_token_changes"])
            env_check.assert_called_once()
            sys_check.assert_called_once()
            identity_check.assert_called_once_with(legacy)
            runtime_check.assert_called_once()
            unused_ref_check.assert_called_once()
            archive_check.assert_called_once_with(path)
            legacy.validate_host_identity_file.assert_called_once()
            legacy.assert_no_active_jobs.assert_called_once()
            run.assert_not_called()
            write.assert_not_called()

    def test_readiness_polls_delayed_start_until_healthy(self):
        clock = {"now": 0.0}
        observations = [
            upgrade.ReadinessObservation(False, "docker_health_starting", True),
            upgrade.ReadinessObservation(
                False, "application_health_endpoint_not_ready", True
            ),
            upgrade.ReadinessObservation(True, "ready"),
        ]
        with (
            patch.object(upgrade.time, "monotonic", side_effect=lambda: clock["now"]),
            patch.object(
                upgrade.time,
                "sleep",
                side_effect=lambda duration: clock.__setitem__("now", clock["now"] + duration),
            ) as sleep,
            patch.object(upgrade, "_check_readiness", side_effect=observations) as check,
        ):
            upgrade._wait_for_healthy(
                upgrade.IMAGE_REF, upgrade.IMAGE_IDS, {"restart_policy": "always"}
            )
        self.assertEqual(check.call_count, 3)
        self.assertEqual(sleep.call_count, 2)
        self.assertEqual(clock["now"], 4.0)

    def test_readiness_fails_immediately_for_permanently_unhealthy_container(self):
        with (
            patch.object(upgrade.time, "monotonic", return_value=0.0),
            patch.object(upgrade.time, "sleep") as sleep,
            patch.object(
                upgrade,
                "_check_readiness",
                return_value=upgrade.ReadinessObservation(False, "container_unhealthy"),
            ) as check,
        ):
            with self.assertRaisesRegex(upgrade.UpgradeError, "container_unhealthy"):
                upgrade._wait_for_healthy(
                    upgrade.IMAGE_REF, upgrade.IMAGE_IDS, {"restart_policy": "always"}
                )
        check.assert_called_once()
        sleep.assert_not_called()

    def test_readiness_timeout_is_bounded_and_preserves_last_safe_category(self):
        clock = {"now": 0.0}

        def sleep(duration):
            clock["now"] += duration

        with (
            patch.object(upgrade, "READINESS_BUDGET_SECONDS", 5.0),
            patch.object(upgrade, "READINESS_POLL_INTERVAL_SECONDS", 2.0),
            patch.object(upgrade.time, "monotonic", side_effect=lambda: clock["now"]),
            patch.object(upgrade.time, "sleep", side_effect=sleep),
            patch.object(
                upgrade,
                "_check_readiness",
                return_value=upgrade.ReadinessObservation(
                    False, "docker_health_starting", True
                ),
            ) as check,
        ):
            with self.assertRaisesRegex(upgrade.UpgradeError, "readiness_timeout") as raised:
                upgrade._wait_for_healthy(
                    upgrade.IMAGE_REF, upgrade.IMAGE_IDS, {"restart_policy": "always"}
                )
        self.assertEqual(raised.exception.cause_category, "docker_health_starting")
        self.assertEqual(clock["now"], 5.0)
        self.assertLessEqual(check.call_count, 3)

    def test_readiness_rejects_image_identity_mismatch_without_retry(self):
        with (
            patch.object(upgrade.time, "monotonic", return_value=0.0),
            patch.object(upgrade.time, "sleep") as sleep,
            patch.object(
                upgrade,
                "_check_readiness",
                return_value=upgrade.ReadinessObservation(False, "image_identity_mismatch"),
            ) as check,
        ):
            with self.assertRaisesRegex(upgrade.UpgradeError, "image_identity_mismatch"):
                upgrade._wait_for_healthy(
                    upgrade.IMAGE_REF, upgrade.IMAGE_IDS, {"restart_policy": "always"}
                )
        check.assert_called_once()
        sleep.assert_not_called()

    def test_readiness_fails_closed_for_identity_mount_and_systemd_mismatches(self):
        cases = (
            "image_identity_mismatch",
            "mount_validation_failed",
            "identity_attestation_failed",
            "systemd_configuration_mismatch",
        )
        for category in cases:
            with self.subTest(category=category):
                with (
                    patch.object(upgrade.time, "monotonic", return_value=0.0),
                    patch.object(upgrade.time, "sleep") as sleep,
                    patch.object(
                        upgrade,
                        "_check_readiness",
                        return_value=upgrade.ReadinessObservation(False, category),
                    ) as check,
                ):
                    with self.assertRaisesRegex(upgrade.UpgradeError, category):
                        upgrade._wait_for_healthy(
                            upgrade.IMAGE_REF,
                            upgrade.IMAGE_IDS,
                            {"restart_policy": "always"},
                        )
                check.assert_called_once()
                sleep.assert_not_called()

    def test_readiness_reports_systemd_configuration_and_container_health_categories(self):
        runtime = {
            "id": "a" * 64,
            "image_id": upgrade.IMAGE_IDS[0],
            "image_ref": upgrade.IMAGE_REF,
            "running": True,
            "health": "starting",
            "restart_policy": "always",
            "groups": ["999", "62000"],
            "port_bindings": {"8080/tcp": [{"HostIp": "127.0.0.1", "HostPort": "8080"}]},
            "mounts": [],
        }
        systemd = {
            "NeedDaemonReload": "no",
            "FragmentPath": str(upgrade.SERVICE_PATH),
            "DropInPaths": "",
            "EnvironmentFiles": "/etc/auterim-verifier/runner.env",
            "ActiveState": "active",
            "Restart": "always",
        }
        legacy = SimpleNamespace(
            IMAGE_REF=identity.IMAGE_REF,
            validate_unit=Mock(return_value={"restart": "always"}),
            _service_directives=Mock(
                return_value={
                    "ExecStop": [("ExecStop", "=", upgrade.EXPECTED_EXECSTOP)]
                }
            ),
            HELPER_PATH=Path("/opt/auterim-verifier/deploy_identity_handoff.py"),
            IDENTITY_DIRECTORY_VALUE="/run/auterim-identity",
            validate_host_identity_file=Mock(),
        )
        expected = {
            "restart_policy": "always",
            "groups": runtime["groups"],
            "port_bindings": runtime["port_bindings"],
        }
        with tempfile.TemporaryDirectory() as directory:
            unit_path = Path(directory) / "runner.service"
            unit_path.write_text(upgrade._patch_unit(identity_enabled_unit()), encoding="utf-8")
            systemd["NeedDaemonReload"] = "yes"
            systemd["FragmentPath"] = str(unit_path)
            with (
                patch.object(upgrade, "SERVICE_PATH", unit_path),
                patch.object(upgrade, "_load_legacy", return_value=legacy),
                patch.object(upgrade, "_assert_readiness_unit_path"),
                patch.object(
                    upgrade,
                    "_readiness_command",
                    side_effect=lambda args, _deadline: systemd[
                        next(arg.split("=", 1)[1] for arg in args if arg.startswith("--property="))
                    ],
                ),
                patch.object(upgrade, "_readiness_container", return_value=runtime),
                patch.object(upgrade, "_validate_mounts"),
                patch.object(upgrade, "_validate_identity_mount_bounded"),
            ):
                mismatch = upgrade._check_readiness(
                    upgrade.IMAGE_REF,
                    upgrade.IMAGE_IDS,
                    expected,
                    100.0,
                )
                self.assertEqual(mismatch.category, "systemd_configuration_mismatch")

                systemd["NeedDaemonReload"] = "no"
                with patch.object(
                    upgrade.subprocess, "run", return_value=SimpleNamespace(returncode=0)
                ):
                    starting = upgrade._check_readiness(
                        upgrade.IMAGE_REF,
                        upgrade.IMAGE_IDS,
                        expected,
                        100.0,
                    )
                self.assertEqual(starting.category, "docker_health_starting")
                self.assertTrue(starting.retryable)

                runtime["health"] = "unhealthy"
                unhealthy = upgrade._check_readiness(
                    upgrade.IMAGE_REF,
                    upgrade.IMAGE_IDS,
                    expected,
                    100.0,
                )
                self.assertEqual(unhealthy.category, "container_unhealthy")
                self.assertFalse(unhealthy.retryable)

                runtime["running"] = False
                exited = upgrade._check_readiness(
                    upgrade.IMAGE_REF, upgrade.IMAGE_IDS, expected, 100.0
                )
                self.assertEqual(exited.category, "container_exited")

                runtime["running"] = True
                runtime["health"] = "healthy"
                runtime["image_id"] = upgrade.OLD_IMAGE_IDS[0]
                image_mismatch = upgrade._check_readiness(
                    upgrade.IMAGE_REF,
                    upgrade.IMAGE_IDS,
                    expected,
                    100.0,
                )
                self.assertEqual(image_mismatch.category, "image_identity_mismatch")

                runtime["image_id"] = upgrade.IMAGE_IDS[0]
                with patch.object(
                    upgrade.subprocess, "run", return_value=SimpleNamespace(returncode=20)
                ):
                    endpoint_not_ready = upgrade._check_readiness(
                        upgrade.IMAGE_REF, upgrade.IMAGE_IDS, expected, 100.0
                    )
                self.assertEqual(
                    endpoint_not_ready.category, "application_health_endpoint_not_ready"
                )
                self.assertTrue(endpoint_not_ready.retryable)

                with patch.object(
                    upgrade.subprocess, "run", return_value=SimpleNamespace(returncode=0)
                ):
                    ready = upgrade._check_readiness(
                        upgrade.IMAGE_REF, upgrade.IMAGE_IDS, expected, 100.0
                    )
                self.assertTrue(ready.ready)

                with patch.object(
                    upgrade, "_validate_mounts", side_effect=upgrade.UpgradeError("mount_bad")
                ):
                    with self.assertRaisesRegex(upgrade.UpgradeError, "mount_validation_failed"):
                        upgrade._check_readiness(
                            upgrade.IMAGE_REF, upgrade.IMAGE_IDS, expected, 100.0
                        )

                legacy.validate_host_identity_file.side_effect = RuntimeError("private detail")
                with self.assertRaisesRegex(
                    upgrade.UpgradeError, "identity_attestation_failed"
                ) as identity_failure:
                    upgrade._check_readiness(
                        upgrade.IMAGE_REF, upgrade.IMAGE_IDS, expected, 100.0
                    )
                self.assertNotIn("private detail", str(identity_failure.exception))

    def test_deployment_and_rollback_failure_categories_are_reported_separately(self):
        failure = upgrade.UpgradeError(
            "deployment_failed",
            cause_category="readiness_timeout",
            cause_detail_category="docker_health_starting",
            rollback="failed",
            rollback_cause_category="readiness_timeout",
            rollback_detail_category="application_health_endpoint_not_ready",
        )
        output = io.StringIO()
        with (
            patch.object(upgrade, "deploy", side_effect=failure),
            redirect_stdout(output),
        ):
            status = upgrade.main(["--deploy", "archive.tar"])
        result = json.loads(output.getvalue())
        self.assertEqual(status, 1)
        self.assertEqual(result["cause_category"], "readiness_timeout")
        self.assertEqual(result["cause_detail_category"], "docker_health_starting")
        self.assertEqual(result["rollback"], "failed")
        self.assertEqual(result["rollback_cause_category"], "readiness_timeout")
        self.assertEqual(
            result["rollback_detail_category"],
            "application_health_endpoint_not_ready",
        )
        self.assertNotIn("private", output.getvalue())

    def test_failure_output_replaces_unapproved_categories_with_safe_fallbacks(self):
        failure = upgrade.UpgradeError(
            "deployment_failed",
            cause_category="credential-value-must-not-appear",
            cause_detail_category="private-detail",
            rollback="failed",
            rollback_cause_category="signed-url-must-not-appear",
            rollback_detail_category="raw-error",
        )
        output = io.StringIO()
        with (
            patch.object(upgrade, "deploy", side_effect=failure),
            redirect_stdout(output),
        ):
            status = upgrade.main(["--deploy", "archive.tar"])
        result = json.loads(output.getvalue())
        self.assertEqual(status, 1)
        self.assertEqual(result["cause_category"], "operation_failed")
        self.assertNotIn("cause_detail_category", result)
        self.assertEqual(result["rollback_cause_category"], "rollback_operation_failed")
        self.assertNotIn("rollback_detail_category", result)
        self.assertNotIn("credential-value-must-not-appear", output.getvalue())
        self.assertNotIn("signed-url-must-not-appear", output.getvalue())

    def test_deploy_health_failure_restores_original_unit_and_old_image(self):
        original = identity_enabled_unit()
        updated = upgrade._patch_unit(original)
        old_runtime = {
            "id": "old-container",
            "image_id": upgrade.OLD_IMAGE_IDS[0],
            "image_ref": upgrade.OLD_IMAGE_REF,
            "restart_policy": "always",
            "groups": ["999", "62000"],
            "port_bindings": {"8080/tcp": [{"HostIp": "127.0.0.1", "HostPort": "8080"}]},
        }
        commands = []

        def write_file(path, data, mode, uid=0, gid=0):
            Path(path).write_bytes(data)

        def command(args, **_kwargs):
            commands.append(args)
            if args[:4] == ["docker", "image", "inspect", "--format"]:
                return upgrade.IMAGE_IDS[1]
            return ""

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "image.tar"
            source.write_bytes(b"archive")
            unit_path = root / "runner.service"
            unit_path.write_text(original, encoding="utf-8")
            backup = root / "backup"
            backup.mkdir()
            observations = [
                upgrade.ReadinessObservation(False, "container_unhealthy"),
                upgrade.ReadinessObservation(False, "docker_health_starting", True),
                upgrade.ReadinessObservation(True, "ready"),
            ]
            clock = {"now": 0.0}
            with (
                patch.object(upgrade.os, "geteuid", return_value=0, create=True),
                patch.object(upgrade.os, "chown", return_value=None, create=True),
                patch.object(
                    upgrade.tempfile,
                    "mkdtemp",
                    side_effect=lambda **_kwargs: (root.joinpath("stage").mkdir() or str(root / "stage")),
                ),
                patch.object(upgrade, "_load_legacy", return_value=SimpleNamespace(_stage_input_file=lambda src, dst, _max: Path(dst).write_bytes(Path(src).read_bytes()))),
                patch.object(upgrade, "preflight", return_value={"archive_sha256": upgrade.IMAGE_ARCHIVE_SHA256}),
                patch.object(upgrade, "_read_unit", return_value=(original.encode(), original, {"command": [], "restart": "always"})),
                patch.object(upgrade, "_validate_runtime", return_value=old_runtime),
                patch.object(upgrade, "_write_backup", return_value=backup),
                patch.object(upgrade, "_docker_load") as load,
                patch.object(upgrade, "_run", side_effect=command),
                patch.object(upgrade, "_atomic_write", side_effect=write_file),
                patch.object(upgrade, "_patch_unit", return_value=updated),
                patch.object(upgrade, "_check_readiness", side_effect=observations) as check,
                patch.object(upgrade.time, "monotonic", side_effect=lambda: clock["now"]),
                patch.object(
                    upgrade.time,
                    "sleep",
                    side_effect=lambda duration: clock.__setitem__(
                        "now", clock["now"] + duration
                    ),
                ) as sleep,
                patch.object(upgrade.shutil, "rmtree") as rmtree,
                patch.object(upgrade, "SERVICE_PATH", unit_path),
            ):
                with self.assertRaisesRegex(upgrade.UpgradeError, "deployment_failed") as raised:
                    upgrade.deploy(source)
            self.assertEqual(raised.exception.cause_category, "container_unhealthy")
            self.assertEqual(raised.exception.rollback, "passed")
            self.assertEqual(unit_path.read_text(encoding="utf-8"), original)
            self.assertEqual(check.call_count, 3)
            sleep.assert_called_once_with(2.0)
            load.assert_called_once()
            self.assertEqual(
                sum(1 for args in commands if args[:2] == ["systemctl", "restart"]), 2
            )
            rmtree.assert_called_once()

    def test_deploy_success_changes_only_image_token_and_restarts_managed_service(self):
        original = identity_enabled_unit()
        updated = upgrade._patch_unit(original)
        old_runtime = {
            "id": "old-container",
            "image_id": upgrade.OLD_IMAGE_IDS[0],
            "image_ref": upgrade.OLD_IMAGE_REF,
            "restart_policy": "",
            "groups": ["999", "62000"],
            "port_bindings": {"8080/tcp": [{"HostIp": "127.0.0.1", "HostPort": "8080"}]},
        }
        commands = []

        def write_file(path, data, _mode, _uid=0, _gid=0):
            Path(path).write_bytes(data)

        def command(args, **_kwargs):
            commands.append(args)
            if args[:4] == ["docker", "image", "inspect", "--format"]:
                return upgrade.IMAGE_IDS[1]
            return ""

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "image.tar"
            source.write_bytes(b"archive")
            unit_path = root / "runner.service"
            unit_path.write_text(original, encoding="utf-8")
            backup = root / "backup"
            backup.mkdir()
            with (
                patch.object(upgrade.os, "geteuid", return_value=0, create=True),
                patch.object(upgrade.os, "chown", return_value=None, create=True),
                patch.object(
                    upgrade.tempfile,
                    "mkdtemp",
                    side_effect=lambda **_kwargs: (root.joinpath("stage").mkdir() or str(root / "stage")),
                ),
                patch.object(upgrade, "_load_legacy", return_value=SimpleNamespace(_stage_input_file=lambda src, dst, _max: Path(dst).write_bytes(Path(src).read_bytes()))),
                patch.object(upgrade, "preflight", return_value={"archive_sha256": upgrade.IMAGE_ARCHIVE_SHA256}),
                patch.object(upgrade, "_read_unit", return_value=(original.encode(), original, {"command": [], "restart": "always"})),
                patch.object(upgrade, "_validate_runtime", return_value=old_runtime),
                patch.object(upgrade, "_write_backup", return_value=backup),
                patch.object(upgrade, "_docker_load") as load,
                patch.object(upgrade, "_run", side_effect=command),
                patch.object(upgrade, "_atomic_write", side_effect=write_file),
                patch.object(upgrade, "_patch_unit", return_value=updated),
                patch.object(
                    upgrade,
                    "_check_readiness",
                    return_value=upgrade.ReadinessObservation(True, "ready"),
                ),
                patch.object(upgrade.shutil, "rmtree") as rmtree,
                patch.object(upgrade, "SERVICE_PATH", unit_path),
            ):
                result = upgrade.deploy(source)
            self.assertEqual(result["status"], "DEPLOY_PASS")
            self.assertEqual(result["image_ref"], upgrade.IMAGE_REF)
            self.assertTrue(result["unit_changed_only_image_token"])
            self.assertEqual(unit_path.read_text(encoding="utf-8"), updated)
            self.assertEqual(sum(1 for args in commands if args[:2] == ["systemctl", "restart"]), 1)
            load.assert_called_once()
            rmtree.assert_called_once()


if __name__ == "__main__":
    unittest.main()
