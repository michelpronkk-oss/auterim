import base64
import json
import unittest
from unittest.mock import call, patch

import fetch_ec2_identity as identity


class HostIdentityRefreshTests(unittest.TestCase):
    def setUp(self):
        self.document = json.dumps(
            {
                "accountId": identity.EXPECTED_ACCOUNT,
                "region": identity.EXPECTED_REGION,
                "instanceId": identity.EXPECTED_INSTANCE,
                "imageId": "ami-0123456789abcdef0",
            },
            separators=(",", ":"),
        )
        self.signature = base64.b64encode(bytes(range(128))).decode("ascii")

    def test_fetches_only_imdsv2_token_and_signed_identity_documents(self):
        with patch.object(
            identity,
            "_metadata_request",
            side_effect=[b"token-in-memory", self.document.encode(), self.signature.encode()],
        ) as request:
            value = identity.fetch_identity(now_ms=1_800_000_000_000)
        self.assertEqual(value["document"], self.document)
        self.assertEqual(value["signature"], self.signature)
        self.assertEqual(value["fetchedAt"], 1_800_000_000_000)
        self.assertEqual(
            request.call_args_list,
            [
                call("PUT", identity.TOKEN_PATH, body_limit=4096),
                call(
                    "GET",
                    identity.DOCUMENT_PATH,
                    token="token-in-memory",
                    body_limit=identity.MAX_DOCUMENT_BYTES,
                ),
                call(
                    "GET",
                    identity.SIGNATURE_PATH,
                    token="token-in-memory",
                    body_limit=identity.MAX_SIGNATURE_BYTES,
                ),
            ],
        )
        self.assertNotIn("credentials", [item.args[1] for item in request.call_args_list])

    def test_rejects_wrong_instance_before_writing(self):
        wrong = json.loads(self.document)
        wrong["instanceId"] = "i-00000000000000000"
        with patch.object(
            identity,
            "_metadata_request",
            side_effect=[b"token", json.dumps(wrong).encode(), self.signature.encode()],
        ):
            with self.assertRaisesRegex(identity.IdentityRefreshError, "metadata_identity_mismatch"):
                identity.fetch_identity()

    def test_rejects_malformed_signature(self):
        with patch.object(
            identity,
            "_metadata_request",
            side_effect=[b"token", self.document.encode(), b"not-a-signature"],
        ):
            with self.assertRaisesRegex(identity.IdentityRefreshError, "metadata_signature_invalid"):
                identity.fetch_identity()

    def test_normalizes_ascii_wrapped_base64_to_canonical_signature(self):
        wrapped = (self.signature[:48] + "\r\n \t" + self.signature[48:]).encode("ascii")
        with patch.object(
            identity,
            "_metadata_request",
            side_effect=[b"token", self.document.encode(), wrapped],
        ):
            value = identity.fetch_identity(now_ms=123)
        self.assertEqual(value["signature"], self.signature)
        self.assertEqual(len(base64.b64decode(value["signature"], validate=True)), 128)

    def test_rejects_non_ascii_whitespace_and_malformed_base64(self):
        malformed_values = (
            b"not-a-signature",
            self.signature.encode("ascii") + b"\x00",
            self.signature.encode("ascii") + "\u00a0".encode("utf-8"),
            self.signature.encode("ascii") + b"\v",
            self.signature.encode("ascii") + b"\f",
        )
        for malformed in malformed_values:
            with self.subTest(malformed=malformed[:16]), patch.object(
                identity,
                "_metadata_request",
                side_effect=[b"token", self.document.encode(), malformed],
            ):
                with self.assertRaisesRegex(identity.IdentityRefreshError, "metadata_signature_invalid"):
                    identity.fetch_identity()

    def test_rejects_rsa_signature_lengths_other_than_128_bytes(self):
        for byte_count in (127, 129):
            signature = base64.b64encode(bytes(byte_count))
            with self.subTest(byte_count=byte_count), patch.object(
                identity,
                "_metadata_request",
                side_effect=[b"token", self.document.encode(), signature],
            ):
                with self.assertRaisesRegex(identity.IdentityRefreshError, "metadata_signature_invalid"):
                    identity.fetch_identity()

    def test_refresh_writes_only_the_fetched_identity(self):
        record = {"document": self.document, "signature": self.signature, "fetchedAt": 123}
        with (
            patch.object(identity, "fetch_identity", return_value=record),
            patch.object(identity, "_write_identity") as write,
        ):
            identity.refresh()
        write.assert_called_once_with(record)

    def test_refresh_does_not_write_when_metadata_fetch_fails(self):
        with (
            patch.object(identity, "fetch_identity", side_effect=identity.IdentityRefreshError("metadata_unavailable")),
            patch.object(identity, "_write_identity") as write,
            patch.object(identity, "_remove_stale_file_if_safe") as remove,
        ):
            with self.assertRaisesRegex(identity.IdentityRefreshError, "metadata_unavailable"):
                identity.refresh()
        write.assert_not_called()
        remove.assert_called_once_with()


if __name__ == "__main__":
    unittest.main()
