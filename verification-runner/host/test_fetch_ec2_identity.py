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
        self.signature = base64.b64encode(bytes(range(256))).decode("ascii")

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
