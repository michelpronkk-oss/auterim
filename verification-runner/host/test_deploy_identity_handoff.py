import unittest
import base64
import hashlib
import io
import json
import tarfile
import tempfile
from pathlib import Path
from unittest.mock import patch

import deploy_identity_handoff as deploy


def unit_text():
    return """[Unit]
Description=Auterim verifier

[Service]
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


class DeploymentParserTests(unittest.TestCase):
    def test_accepts_validated_shell_wrapper_and_preserves_existing_arguments(self):
        original = unit_text()
        before = deploy.validate_unit(original)
        changed = deploy.patch_unit(original)
        after = deploy.validate_unit(changed, allow_identity_mount=True)
        self.assertEqual(before["restart"], after["restart"])
        self.assertEqual(before["environment_file_count"], after["environment_file_count"])
        expected_added = [
            "--group-add",
            "62000",
            "--mount",
            "type=bind,source=/run/auterim-verifier-identity,target=/run/auterim-verifier-identity,readonly",
        ]
        self.assertEqual(after["command"], before["command"][:-1] + expected_added + [deploy.IMAGE_REF])
        self.assertIn("ExecStartPre=-/usr/bin/systemctl start auterim-verifier-identity-refresh.service", changed)

    def test_rejects_missing_public_key_handoff(self):
        malformed = unit_text().replace("FIX_DEPENDENCY_CACHE_PUBLIC_KEY", "MISSING_KEY")
        with self.assertRaisesRegex(deploy.PreflightError, "systemd_environment_handoff_mismatch"):
            deploy.validate_unit(malformed)

    def test_rejects_extra_shell_command(self):
        malformed = unit_text().replace("exec docker run", "exec docker run; touch /tmp/unsafe")
        with self.assertRaisesRegex(deploy.PreflightError, "systemd_shell_operator_unsupported"):
            deploy.validate_unit(malformed)

    def test_rejects_unapproved_docker_capabilities_network_and_mounts(self):
        cases = [
            ("--pull=never", "--pull=never --privileged"),
            (
                "--mount type=bind,source=/srv/auterim-runner,target=/srv/auterim-runner",
                "--mount type=bind,source=/srv/auterim-runner,target=/srv/auterim-runner,readonly",
            ),
        ]
        for before, after in cases:
            with self.subTest(after=after):
                malformed = unit_text().replace(before, after)
                with self.assertRaises(deploy.PreflightError):
                    deploy.validate_unit(malformed)

    def test_publish_binding_is_parsed_and_cross_checked_without_changing_networking(self):
        binding = deploy.parse_publish_binding("127.0.0.1:8080:8080")
        self.assertEqual(
            binding,
            {
                "hostIp": "127.0.0.1",
                "hostPort": "8080",
                "containerPort": "8080",
                "protocol": "tcp",
            },
        )
        self.assertTrue(
            deploy.publish_binding_matches_runtime(
                binding, {"8080/tcp": [{"HostIp": "127.0.0.1", "HostPort": "8080"}]}
            )
        )
        self.assertFalse(
            deploy.publish_binding_matches_runtime(
                binding, {"8080/tcp": [{"HostIp": "0.0.0.0", "HostPort": "8080"}]}
            )
        )
        with self.assertRaisesRegex(deploy.PreflightError, "systemd_publish_binding_unsafe"):
            deploy.parse_publish_binding("0.0.0.0:9000:2375")

    def test_host_identity_record_requires_fresh_exact_instance_and_rsa_signature_shape(self):
        now = 1_800_000_000_000
        valid = {
            "document": json.dumps(
                {
                    "accountId": deploy.EXPECTED_ACCOUNT,
                    "region": deploy.EXPECTED_REGION,
                    "instanceId": deploy.EXPECTED_INSTANCE,
                    "imageId": "ami-0123456789abcdef0",
                },
                separators=(",", ":"),
            ),
            "signature": base64.b64encode(bytes(range(256))).decode("ascii"),
            "fetchedAt": now,
        }
        deploy.validate_identity_record(json.dumps(valid).encode(), now)
        stale = {**valid, "fetchedAt": now - deploy.MAX_IDENTITY_AGE_MS - 1}
        with self.assertRaisesRegex(deploy.PreflightError, "host_identity_record_invalid_or_stale"):
            deploy.validate_identity_record(json.dumps(stale).encode(), now)
        wrong_instance = {**valid, "document": valid["document"].replace(deploy.EXPECTED_INSTANCE, "i-00000000000000000")}
        with self.assertRaisesRegex(deploy.PreflightError, "host_identity_record_invalid_or_stale"):
            deploy.validate_identity_record(json.dumps(wrong_instance).encode(), now)
        with self.assertRaisesRegex(deploy.PreflightError, "host_identity_record_invalid_or_stale"):
            deploy.validate_identity_record(json.dumps({**valid, "unexpected": True}).encode(), now)
        with self.assertRaisesRegex(deploy.PreflightError, "host_identity_record_invalid_or_stale"):
            deploy.validate_identity_record(
                json.dumps({**valid, "signature": "not-base64"}).encode(), now
            )

    def test_deployment_artifact_staging_is_bounded_and_copies_exact_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.bin"
            staged = root / "staged.bin"
            source.write_bytes(b"approved artifact")
            deploy._stage_input_file(source, staged, 64)
            self.assertEqual(staged.read_bytes(), b"approved artifact")
            with self.assertRaisesRegex(
                deploy.PreflightError, "deployment_artifact_input_unsafe"
            ):
                deploy._stage_input_file(root, root / "not-a-file", 64)
            with self.assertRaisesRegex(
                deploy.PreflightError, "deployment_artifact_input_unsafe"
            ):
                deploy._stage_input_file(source, root / "oversized.bin", 4)

    def test_reads_only_pinned_oci_config_path_from_docker_save_archive(self):
        with tempfile.TemporaryDirectory() as directory:
            archive_path = Path(directory) / "runner.tar"
            config = b'{"architecture":"amd64","os":"linux"}'
            config_digest = hashlib.sha256(config).hexdigest()
            config_path = f"blobs/sha256/{config_digest}"
            manifest = json.dumps(
                [{"Config": config_path, "RepoTags": [deploy.IMAGE_REF], "Layers": []}]
            ).encode()
            with patch.object(deploy, "IMAGE_CONFIG_ID", "sha256:" + config_digest):
                with tarfile.open(archive_path, "w:") as archive:
                    for name, content in (("manifest.json", manifest), (config_path, config)):
                        info = tarfile.TarInfo(name)
                        info.size = len(content)
                        archive.addfile(info, io.BytesIO(content))
                self.assertEqual(
                    deploy.image_id_from_docker_archive(archive_path), "sha256:" + config_digest
                )
            bad_manifest = json.dumps(
                [{"Config": "blobs/sha256/../config", "RepoTags": [deploy.IMAGE_REF], "Layers": []}]
            ).encode()
            with tarfile.open(archive_path, "w:") as archive:
                info = tarfile.TarInfo("manifest.json")
                info.size = len(bad_manifest)
                archive.addfile(info, io.BytesIO(bad_manifest))
            with self.assertRaisesRegex(deploy.PreflightError, "image_archive_config_invalid"):
                deploy.image_id_from_docker_archive(archive_path)

    def test_automatic_rollback_restores_prior_unit_and_retags_prior_image(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            backup = root / "backup"
            backup.mkdir()
            service_path = root / "runner.service"
            prior_unit = b"[Service]\nExecStart=old\n"
            (backup / "runner.service").write_bytes(prior_unit)
            (backup / "metadata.json").write_text(json.dumps({"serviceMode": 0o644}))
            helper_path = root / "helper.py"
            refresh_service = root / "refresh.service"
            refresh_timer = root / "refresh.timer"
            identity_dir = root / "identity"
            commands = []

            def write_file(path, data, mode, group_id=0):
                Path(path).write_bytes(data)

            with (
                patch.object(deploy, "SERVICE_PATH", service_path),
                patch.object(deploy, "HELPER_PATH", helper_path),
                patch.object(deploy, "REFRESH_SERVICE_PATH", refresh_service),
                patch.object(deploy, "REFRESH_TIMER_PATH", refresh_timer),
                patch.object(deploy, "IDENTITY_DIRECTORY", identity_dir),
                patch.object(deploy, "_atomic_write", side_effect=write_file),
                patch.object(deploy, "_run", side_effect=lambda args, **kwargs: commands.append(args) or ""),
                patch.object(deploy, "_health_check", return_value=True),
            ):
                self.assertTrue(
                    deploy._rollback(
                        backup,
                        [{"Source": "/old", "Destination": "/old"}],
                        ["123"],
                        "always",
                        "sha256:" + "a" * 64,
                        {"8080/tcp": [{"HostIp": "127.0.0.1", "HostPort": "8080"}]},
                    )
                )
            self.assertEqual(service_path.read_bytes(), prior_unit)
            self.assertTrue(
                any(command[:3] == ["docker", "tag", "sha256:" + "a" * 64] for command in commands)
            )

    def test_rejects_any_additional_docker_option_even_if_existing_options_match(self):
        malformed = unit_text().replace(
            "--publish 127.0.0.1:8080:8080",
            "--publish 127.0.0.1:8080:8080 --network host",
        )
        with self.assertRaisesRegex(
            deploy.PreflightError, "systemd_docker_invocation_has_unapproved_arguments"
        ):
            deploy.validate_unit(malformed)

    def test_rejects_different_socket_group_substitution(self):
        malformed = unit_text().replace("stat -c %%g /var/run/docker.sock", "id -u")
        with self.assertRaisesRegex(deploy.PreflightError, "systemd_shell_substitution_unsupported"):
            deploy.validate_unit(malformed)

    def test_rejects_systemd_percent_specifiers_outside_the_exact_group_lookup(self):
        malformed = unit_text().replace("--rm --name", "--rm %%n --name")
        with self.assertRaisesRegex(deploy.PreflightError, "systemd_shell_operator_unsupported"):
            deploy.validate_unit(malformed)

    def test_rejects_pull_policy_that_could_fetch_an_unpinned_remote_tag(self):
        malformed = unit_text().replace("--pull=never", "--pull=always")
        with self.assertRaisesRegex(deploy.PreflightError, "runner_pull_policy_not_safe_for_pinned_local_image"):
            deploy.validate_unit(malformed)

    def test_rejects_unexpected_existing_mount_count(self):
        malformed = unit_text().replace("--publish 127.0.0.1:8080:8080", "--publish 127.0.0.1:8080:8080 --mount type=bind,source=/tmp,target=/tmp")
        with self.assertRaisesRegex(deploy.PreflightError, "systemd_existing_mount_or_publish_shape_mismatch"):
            deploy.validate_unit(malformed)

    def test_rejects_different_restart_or_environment_file_contract(self):
        with self.assertRaisesRegex(deploy.PreflightError, "systemd_environment_file_mismatch"):
            deploy.validate_unit(unit_text().replace("/etc/auterim-verifier/runner.env", "/tmp/other.env"))
        with self.assertRaisesRegex(deploy.PreflightError, "systemd_restart_policy_ambiguous"):
            deploy.validate_unit(unit_text().replace("Restart=always", "Restart=always\nRestart=on-failure"))

    def test_rejects_unreviewed_systemd_execution_hooks(self):
        malformed = unit_text().replace("Restart=always", "ExecStartPost=/bin/sh -c unsafe\nRestart=always")
        with self.assertRaisesRegex(
            deploy.PreflightError, "systemd_extra_execution_directive_unsupported"
        ):
            deploy.validate_unit(malformed)

    def test_preflight_job_scan_allows_terminal_records_but_rejects_active_or_inflight(self):
        with tempfile.TemporaryDirectory() as directory:
            store = Path(directory)
            (store / "artifacts").mkdir()
            terminal = {"version": 1, "state": {"status": "completed"}, "mac": "redacted"}
            (store / ("a" * 64 + ".json")).write_text(json.dumps(terminal), encoding="utf-8")
            self.assertEqual(deploy.assert_no_active_jobs(store), 0)
            active = {"version": 1, "state": {"status": "running"}, "mac": "redacted"}
            (store / ("b" * 64 + ".json")).write_text(json.dumps(active), encoding="utf-8")
            with self.assertRaisesRegex(deploy.PreflightError, "runner_has_active_jobs"):
                deploy.assert_no_active_jobs(store)
            (store / ("b" * 64 + ".json")).unlink()
            (store / ("c" * 64 + ".tmp")).write_text("", encoding="utf-8")
            with self.assertRaisesRegex(deploy.PreflightError, "runner_admission_in_progress"):
                deploy.assert_no_active_jobs(store)

    def test_rejects_duplicate_image_reference_and_preexisting_identity_handoff(self):
        with self.assertRaisesRegex(deploy.PreflightError, "systemd_image_token_not_unique"):
            deploy.patch_unit(unit_text().replace("Restart=always", "# auterim-verification-runner:ac73ed8'\nRestart=always"))
        with self.assertRaisesRegex(deploy.PreflightError, "identity_handoff_already_present"):
            deploy.validate_unit(unit_text().replace("--publish", "--mount type=bind,source=/run/auterim-verifier-identity,target=/run/auterim-verifier-identity,readonly --publish"))


if __name__ == "__main__":
    unittest.main()
