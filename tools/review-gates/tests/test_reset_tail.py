"""reset_tail.py — mirror the runner's own stage-reset shape so a relaunch
re-enters the review tail at intake."""

import json


def seed_state(tmp_path, status="failed"):
    state_dir = tmp_path / ".pi" / "pipeline" / "state"
    state_dir.mkdir(parents=True)
    doc = {
        "storyId": "STY-91", "runDefId": "sdlc-with-review",
        "status": status, "currentStage": "review-approval",
        "regressions": 11, "finishedAt": "2026-08-17T21:47:07Z",
        "stages": {
            "dev-story": {"status": "passed", "attempts": 20,
                          "startedAt": "x", "finishedAt": "y"},
            "review-sweep": {"status": "passed", "attempts": 3,
                             "startedAt": "x", "finishedAt": "y"},
            "review-intake": {"status": "passed", "attempts": 7,
                              "startedAt": "x", "finishedAt": "y"},
            "review-classify": {"status": "passed", "attempts": 5,
                                "startedAt": "x", "finishedAt": "y"},
            "review-reconcile": {"status": "passed", "attempts": 5,
                                 "startedAt": "x", "finishedAt": "y"},
            "review-approval-retry": {"status": "passed", "attempts": 5,
                                      "startedAt": "x", "finishedAt": "y"},
            "review-approval": {"status": "failed", "attempts": 7,
                                "startedAt": "x", "finishedAt": "y",
                                "reason": "escalated"},
        },
    }
    path = state_dir / "STY-91.json"
    path.write_text(json.dumps(doc))
    return path


def test_resets_review_tail_to_pending(tmp_path):
    import reset_tail

    path = seed_state(tmp_path)
    assert reset_tail.main(["--state-file", str(path)]) == 0
    doc = json.loads(path.read_text())
    assert doc["status"] == "pending"
    assert doc["finishedAt"] is None
    assert doc["currentStage"] == "review-sweep"
    for stage in ("review-sweep", "review-intake", "review-classify",
                  "review-reconcile", "review-approval-retry",
                  "review-approval"):
        st = doc["stages"][stage]
        assert st["status"] == "pending"
        assert st["startedAt"] is None
        assert st["finishedAt"] is None
    assert doc["stages"]["review-approval"]["attempts"] == 7   # history kept
    assert doc["stages"]["dev-story"]["status"] == "passed"    # untouched


def test_refuses_running_pipeline(tmp_path):
    import reset_tail

    path = seed_state(tmp_path, status="running")
    assert reset_tail.main(["--state-file", str(path)]) == 2


def test_refuses_held_dispatch_lock(tmp_path):
    import reset_tail

    path = seed_state(tmp_path)
    lock = tmp_path / ".pi" / "pipeline" / "locks" / "STY-91"
    lock.mkdir(parents=True)
    (lock / "info.json").write_text("{}")
    assert reset_tail.main(["--state-file", str(path)]) == 2
