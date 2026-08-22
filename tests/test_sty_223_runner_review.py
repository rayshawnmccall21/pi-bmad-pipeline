from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path
from unittest.mock import Mock, patch


RUNNER_PATH = (
    Path(__file__).resolve().parents[1] / ".pi" / "bmad" / "scripts" / "run-pipeline.py"
)


def load_runner_module():
    module_spec = importlib.util.spec_from_file_location("sty_223_review_runner", RUNNER_PATH)
    if module_spec is None or module_spec.loader is None:
        raise RuntimeError("could not load the pipeline runner")
    runner_module = importlib.util.module_from_spec(module_spec)
    module_spec.loader.exec_module(runner_module)
    return runner_module


class FakeProcess:
    def __init__(self, lines: list[str], returncode: int) -> None:
        self.stdout = iter(lines)
        self.returncode = returncode
        self.pid = 12345

    def wait(self, timeout: int | None = None) -> int:
        return self.returncode


class PipelineRunnerReviewFindingsTest(unittest.TestCase):
    def test_rejects_issue_response_when_identifier_does_not_match_request(self) -> None:
        runner_module = load_runner_module()
        mismatched_response = {
            "data": {
                "issue": {
                    "id": "wrong-issue-uuid",
                    "identifier": "STY-999",
                    "title": "Different story",
                    "team": {"id": "team-id"},
                }
            }
        }

        with patch.object(runner_module, "linear_post", return_value=mismatched_response):
            self.assertEqual(("STY-223", None), runner_module.resolve_issue("STY-223"))

    def test_rejects_jsonl_event_envelopes_with_unknown_fields(self) -> None:
        runner_module = load_runner_module()
        event_with_unknown_field = {
            "event": "result",
            "status": "passed",
            "stagesRun": [],
            "regressions": 0,
            "durationMs": 0,
            "untrusted": {"nested": "payload"},
        }

        self.assertFalse(runner_module.valid_event(event_with_unknown_field))

    def test_does_not_mark_linear_done_when_supervisor_exits_nonzero(self) -> None:
        runner_module = load_runner_module()
        passed_result = (
            '{"event":"result","status":"passed","stagesRun":[],"regressions":0,'
            '"durationMs":0}\n'
        )
        update_status = Mock()

        with (
            patch.object(runner_module, "BMAD_CLI", RUNNER_PATH),
            patch.object(runner_module, "LINEAR_API_KEY", "test-key"),
            patch.object(runner_module, "resolve_pipeline_id", return_value="pipeline"),
            patch.object(runner_module, "validate_story_source_intake"),
            patch.object(runner_module, "resolve_issue", return_value=("issue-id", "team-id")),
            patch.object(runner_module, "post_comment"),
            patch.object(runner_module, "update_status", update_status),
            patch.object(
                runner_module.subprocess,
                "Popen",
                return_value=FakeProcess([passed_result], returncode=1),
            ),
            patch.object(sys, "argv", ["run-pipeline.py", "STY-223", "--pipeline", "pipeline"]),
        ):
            self.assertEqual(1, runner_module.main())

        self.assertNotIn(
            unittest.mock.call("issue-id", "team-id", "Done"),
            update_status.call_args_list,
        )


if __name__ == "__main__":
    unittest.main()
