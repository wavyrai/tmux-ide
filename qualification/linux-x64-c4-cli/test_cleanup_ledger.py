"""Offline ledger regression; Docker operations are forbidden in this fixture."""
import hashlib
import json
import os
import pathlib
import runpy
import tempfile
import unittest
from unittest.mock import patch


class CleanupLedgerTest(unittest.TestCase):
    def test_only_root_manifest_is_excluded_and_nested_receipt_is_bound(self):
        script = pathlib.Path(__file__).with_name('cleanup.py')
        with tempfile.TemporaryDirectory() as temp:
            evidence = pathlib.Path(temp) / 'x64-cli-evidence'
            nested = evidence / 'input-and-runner-receipts'
            nested.mkdir(parents=True)
            previous = nested / 'artifact-hashes.json'
            previous.write_bytes(b'{"immutable-prior-receipt":"hash"}\n')
            payload = evidence / 'payload.bin'
            payload.write_bytes(b'payload')
            root = evidence / 'artifact-hashes.json'
            root.write_bytes(b'stale root ledger')
            expected = {
                'input-and-runner-receipts/artifact-hashes.json': hashlib.sha256(previous.read_bytes()).hexdigest(),
                'payload.bin': hashlib.sha256(payload.read_bytes()).hexdigest(),
            }
            with patch.dict(os.environ, {'RUNNER_TEMP': temp}), patch('subprocess.run', side_effect=AssertionError('Docker forbidden')), patch('subprocess.check_output', side_effect=AssertionError('Docker forbidden')):
                runpy.run_path(str(script))
                self.assertEqual(json.loads(root.read_text()), expected)
                first = root.read_bytes()
                runpy.run_path(str(script))
                self.assertEqual(root.read_bytes(), first)
            self.assertEqual(previous.read_bytes(), b'{"immutable-prior-receipt":"hash"}\n')


if __name__ == '__main__':
    unittest.main()
