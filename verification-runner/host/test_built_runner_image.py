import json
import os
import subprocess
import sys
import unittest
from pathlib import Path


class BuiltRunnerImageTests(unittest.TestCase):
    @unittest.skipUnless(
        os.environ.get("M1578R_RUNNER_IMAGE_ARCHIVE"),
        "set M1578R_RUNNER_IMAGE_ARCHIVE for the built-image release test",
    )
    def test_actual_built_image_matches_archive_and_embedded_runtime_reference(self):
        archive_path = Path(os.environ["M1578R_RUNNER_IMAGE_ARCHIVE"])
        checker = Path(__file__).with_name("verify_built_runner_image.py")
        result = subprocess.run(
            [sys.executable, str(checker), "--archive", str(archive_path)],
            check=False,
            capture_output=True,
            text=True,
            timeout=180,
        )
        self.assertEqual(result.returncode, 0)
        evidence = json.loads(result.stdout)
        self.assertEqual(evidence["status"], "IMAGE_VALIDATION_PASS")
        self.assertTrue(evidence["embedded_deployment_image_ref_matches"])
        self.assertTrue(evidence["container_config_image_matches"])
        self.assertEqual(
            evidence["image_ref"],
            "auterim-verification-runner:m1578r-self-id-20261019-03",
        )


if __name__ == "__main__":
    unittest.main()
