"""compose_pipeline.py — the docs-before-PR invariant is enforced, not assumed."""

import pytest

yaml = pytest.importorskip("yaml")


def load_composer():
    import compose_pipeline

    return compose_pipeline


def test_docs_precedes_update_pr_in_composed_sdlc(tmp_path):
    cp = load_composer()
    import argparse

    args = argparse.Namespace(
        story_id="STY-91", pr=561, repo="o/r",
        base=str(cp.REPO_ROOT / ".pi/bmad/pipelines/sdlc.yaml"),
        scripts_dir=str(cp.TOOLS_DIR), extensions=cp.DEFAULT_EXTENSIONS,
        live_reconcile=False, max_regressions=6,
    )
    sdlc, post_pr = cp.compose(args)
    ids = [s["id"] for s in sdlc["stages"]]
    assert ids.index("docs") < ids.index("docs-verify") < ids.index("update-pr")
    assert ids.index("update-pr") < ids.index("review-intake")
    cp.check_invariants(sdlc)  # must not raise
    cp.check_invariants(post_pr)

    agents = [s for s in sdlc["stages"] if s["kind"] == "agent"]
    assert agents, "sdlc must have agent stages"
    names = [s["oName"] for s in agents]
    assert len(names) == len(set(names)), "every agent stage needs its own oName"
    for stage in agents:
        assert stage["oPool"] == "STY-91"
        assert stage["oName"] == f"STY-91-{stage['id']}"
        assert stage["oTag"] == stage["id"]
        assert stage["extensions"], "agent stages must load the observability extensions"
        assert any("pi-observability" in e for e in stage["extensions"])


def test_invariant_rejects_docs_after_update_pr(tmp_path):
    cp = load_composer()
    bad = {"id": "bad", "stages": [
        {"id": "dev-story", "kind": "agent"},
        {"id": "update-pr", "kind": "agent"},
        {"id": "docs", "kind": "agent"},
        {"id": "docs-verify", "kind": "code", "onFail": "docs"},
    ]}
    with pytest.raises(SystemExit):
        cp.check_invariants(bad)


def test_invariant_rejects_update_pr_without_docs_verify(tmp_path):
    cp = load_composer()
    bad = {"id": "bad", "stages": [
        {"id": "docs", "kind": "agent"},
        {"id": "update-pr", "kind": "agent"},
    ]}
    with pytest.raises(SystemExit):
        cp.check_invariants(bad)
