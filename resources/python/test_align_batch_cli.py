"""Tests for the bundled align_batch_cli script (output safety & skip logic).

Run with:  python -m pytest resources/python/test_align_batch_cli.py -v
(requires the munajjam package to be installed or on PYTHONPATH)
"""

import importlib.util
import json
from pathlib import Path
from unittest.mock import MagicMock

import pytest

# Load the script as a module by file path (it is not a package member).
_script_path = Path(__file__).with_name("align_batch_cli.py")
_spec = importlib.util.spec_from_file_location("align_batch_cli", _script_path)
_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)

_is_complete_output = _mod._is_complete_output
write_output = _mod.write_output


# ── Helpers ───────────────────────────────────────────────────────────────────

def _make_result(ayah_number: int, start: float, end: float, similarity: float = 0.9):
    r = MagicMock()
    r.ayah.ayah_number = ayah_number
    r.start_time = start
    r.end_time = end
    r.similarity_score = similarity
    return r


# ── _is_complete_output ───────────────────────────────────────────────────────

class TestIsCompleteOutput:
    def test_missing_file_returns_false(self, tmp_path):
        assert _is_complete_output(tmp_path / "001.json") is False

    def test_empty_file_returns_false(self, tmp_path):
        p = tmp_path / "001.json"
        p.write_text("")
        assert _is_complete_output(p) is False

    def test_invalid_json_returns_false(self, tmp_path):
        p = tmp_path / "001.json"
        p.write_text("{not valid json")
        assert _is_complete_output(p) is False

    def test_json_without_ayahs_key_returns_false(self, tmp_path):
        p = tmp_path / "001.json"
        p.write_text(json.dumps({"surah_id": 1}))
        assert _is_complete_output(p) is False

    def test_json_with_empty_ayahs_returns_false(self, tmp_path):
        p = tmp_path / "001.json"
        p.write_text(json.dumps({"surah_id": 1, "ayahs": []}))
        assert _is_complete_output(p) is False

    def test_valid_output_returns_true(self, tmp_path):
        p = tmp_path / "001.json"
        p.write_text(json.dumps({"surah_id": 1, "ayahs": [{"ayah_number": 1}]}))
        assert _is_complete_output(p) is True

    def test_truncated_file_returns_false(self, tmp_path):
        """Simulates a file left half-written by a crash."""
        p = tmp_path / "001.json"
        p.write_bytes(b'{"surah_id": 1, "ayahs": [{"ayah_number": 1, "star')
        assert _is_complete_output(p) is False


# ── write_output atomic write ─────────────────────────────────────────────────

class TestWriteOutputAtomic:
    def test_produces_valid_json_file(self, tmp_path):
        results = [_make_result(1, 0.0, 3.5), _make_result(2, 3.5, 7.0)]
        write_output(tmp_path, 1, results)

        out = tmp_path / "001.json"
        assert out.exists()
        data = json.loads(out.read_text(encoding="utf-8"))
        assert data["surah_id"] == 1
        assert len(data["ayahs"]) == 2

    def test_no_tmp_file_left_after_successful_write(self, tmp_path):
        write_output(tmp_path, 1, [_make_result(1, 0.0, 3.5)])

        tmp_files = list(tmp_path.glob("*.tmp"))
        assert tmp_files == [], f"Unexpected .tmp files left behind: {tmp_files}"

    def test_output_passes_skip_guard(self, tmp_path):
        """The written file must pass the same validation used by the skip guard."""
        write_output(tmp_path, 1, [_make_result(i, float(i), float(i + 1)) for i in range(1, 4)])

        assert _is_complete_output(tmp_path / "001.json") is True

    def test_overwrites_existing_file(self, tmp_path):
        write_output(tmp_path, 1, [_make_result(1, 0.0, 3.5)])
        write_output(tmp_path, 1, [_make_result(1, 1.0, 4.0, similarity=0.95)])

        data = json.loads((tmp_path / "001.json").read_text(encoding="utf-8"))
        assert data["ayahs"][0]["start"] == 1.0
