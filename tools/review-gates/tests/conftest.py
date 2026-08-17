import os
import stat
import sys
from pathlib import Path

import pytest

TOOLS_DIR = Path(__file__).resolve().parents[1]
FIXTURES = TOOLS_DIR / "fixtures" / "pr-561"
sys.path.insert(0, str(TOOLS_DIR))


@pytest.fixture()
def fake_gh(monkeypatch):
    """Route every gh() call through tests/fake_gh.py against the pr-561 corpus."""
    fake = Path(__file__).parent / "fake_gh.py"
    fake.chmod(fake.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setenv("RG_GH", str(fake))
    monkeypatch.setenv("RG_FIXDIR", str(FIXTURES))
    return fake


@pytest.fixture()
def out_dir(tmp_path):
    return tmp_path / "review-loop"


@pytest.fixture()
def fixture_ledger(fake_gh, out_dir):
    """A real ledger produced by review_intake against the fixture corpus."""
    import review_intake

    code = review_intake.main([
        "--pr", "561", "--repo", "rayshawnmccall21/StylePassV2",
        "--out", str(out_dir), "--story-id", "STY-91",
        "--max-polls", "1", "--allow-detached",
    ])
    assert code == 0
    import json

    return json.loads((out_dir / "ledger.json").read_text())
