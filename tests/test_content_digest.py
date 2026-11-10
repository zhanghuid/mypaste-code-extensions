from __future__ import annotations

import importlib.util
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def load_build():
    spec = importlib.util.spec_from_file_location(
        "build_official", ROOT / "scripts" / "build-official.py")
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


class ContentDigestTests(unittest.TestCase):
    def test_matches_the_host_algorithm(self) -> None:
        # The expected value was computed by the host's
        # internal/extension.ContentDigest over the same two files. Paths sort
        # before hashing, so the order the files are written in is irrelevant.
        build = load_build()
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            (directory / "b.txt").write_bytes(b"two")
            (directory / "a.txt").write_bytes(b"one")
            self.assertEqual(
                build.content_digest(directory),
                "f84a18636471f6198c02338b3a2eaadf3540608b380867f37df8d67943422524",
            )

    def test_covers_nested_paths(self) -> None:
        build = load_build()
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            (directory / "bin" / "darwin").mkdir(parents=True)
            (directory / "bin" / "darwin" / "run").write_bytes(b"binary")
            (directory / "mypaste.plugin.json").write_bytes(b"{}")
            self.assertRegex(build.content_digest(directory), r"^[0-9a-f]{64}$")


if __name__ == "__main__":
    unittest.main()
