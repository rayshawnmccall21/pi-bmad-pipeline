"""verify_docs.py — the docs gate recomputes the changed-since-main set
exactly the way code-review scopes changes (origin/main...HEAD three-dot
merge-base diff + working tree + index) and verifies the docs stage's
coverage manifest against it. Claims are never trusted: doc-updated only
counts when the claimed doc itself changed since main."""

import json
import subprocess

import pytest


def sh(cwd, *args):
    r = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    return r.stdout.strip()


@pytest.fixture()
def repo(tmp_path, monkeypatch):
    root = tmp_path / "repo"
    root.mkdir()
    sh(root, "init", "-q", "-b", "main")
    sh(root, "config", "user.email", "t@t")
    sh(root, "config", "user.name", "t")
    (root / "src").mkdir()
    (root / "docs").mkdir()
    (root / "src/app.py").write_text("v1\n")
    (root / "docs/guide.md").write_text("guide v1\n")
    sh(root, "add", "-A")
    sh(root, "commit", "-qm", "base")
    base = sh(root, "rev-parse", "HEAD")
    sh(root, "update-ref", "refs/remotes/origin/main", base)
    sh(root, "checkout", "-qb", "feature")
    (root / "src/app.py").write_text("v2\n")
    (root / "docs/guide.md").write_text("guide v2\n")
    sh(root, "add", "-A")
    sh(root, "commit", "-qm", "change")
    monkeypatch.chdir(root)
    return root


def manifest(root, entries, merge_base=None):
    doc = {
        "schema": "docs-coverage.v1",
        "baseRef": "origin/main",
        "mergeBase": merge_base or sh(root, "merge-base", "origin/main", "HEAD"),
        "entries": entries,
    }
    path = root / ".pi/artifacts/docs/coverage.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(doc, indent=2))
    return path


def run(root):
    import verify_docs

    return verify_docs.main(["--out", str(root / ".pi/artifacts/docs")])


def read_findings(root):
    return json.loads((root / ".pi/artifacts/docs/findings.json").read_text())


def test_full_coverage_passes(repo):
    manifest(repo, [
        {"path": "src/app.py", "disposition": "doc-updated", "docPath": "docs/guide.md"},
        {"path": "docs/guide.md", "disposition": "no-doc-impact",
         "reason": "is itself documentation"},
    ])
    assert run(repo) == 0


def test_missing_manifest_regresses_with_instruction(repo):
    assert run(repo) == 1
    findings = read_findings(repo)
    assert findings["findings"][0]["fingerprint"] == "meta:docs-coverage"
    texts = " ".join(f["text"] for f in findings["findings"])
    assert "src/app.py" in texts


def test_uncovered_changed_file_fails(repo):
    manifest(repo, [
        {"path": "docs/guide.md", "disposition": "no-doc-impact", "reason": "doc"},
    ])
    assert run(repo) == 1
    texts = " ".join(f["text"] for f in read_findings(repo)["findings"])
    assert "src/app.py" in texts


def test_doc_updated_claim_requires_the_doc_to_have_changed(repo):
    (repo / "docs/other.md").write_text("never changed on this branch")
    sh(repo, "add", "docs/other.md")
    sh(repo, "commit", "-qm", "add other doc")
    sh(repo, "update-ref", "refs/remotes/origin/main", sh(repo, "rev-parse", "HEAD"))
    (repo / "src/app.py").write_text("v3\n")
    sh(repo, "add", "-A")
    sh(repo, "commit", "-qm", "change app only")
    manifest(repo, [
        {"path": "src/app.py", "disposition": "doc-updated", "docPath": "docs/other.md"},
    ])
    assert run(repo) == 1
    texts = " ".join(f["text"] for f in read_findings(repo)["findings"])
    assert "docs/other.md" in texts


def test_stale_merge_base_fails(repo):
    manifest(repo, [
        {"path": "src/app.py", "disposition": "doc-updated", "docPath": "docs/guide.md"},
        {"path": "docs/guide.md", "disposition": "no-doc-impact", "reason": "doc"},
    ], merge_base="0" * 40)
    assert run(repo) == 1


def test_uncommitted_changes_count_like_code_review(repo):
    (repo / "src/extra.py").write_text("dirty new file\n")
    sh(repo, "add", "src/extra.py")  # staged, uncommitted
    manifest(repo, [
        {"path": "src/app.py", "disposition": "doc-updated", "docPath": "docs/guide.md"},
        {"path": "docs/guide.md", "disposition": "no-doc-impact", "reason": "doc"},
    ])
    assert run(repo) == 1
    texts = " ".join(f["text"] for f in read_findings(repo)["findings"])
    assert "src/extra.py" in texts


def test_pipeline_exhaust_is_exempt(repo):
    (repo / ".pi/artifacts/review-loop").mkdir(parents=True)
    (repo / ".pi/artifacts/review-loop/ledger.json").write_text("{}")
    sh(repo, "add", "-A")
    sh(repo, "commit", "-qm", "exhaust")
    manifest(repo, [
        {"path": "src/app.py", "disposition": "doc-updated", "docPath": "docs/guide.md"},
        {"path": "docs/guide.md", "disposition": "no-doc-impact", "reason": "doc"},
    ])
    assert run(repo) == 0
