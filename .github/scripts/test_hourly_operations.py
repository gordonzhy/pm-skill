"""Synthetic API contracts; never reads a token or calls GitHub."""
import copy
import contextlib
import io
from unittest import mock
import importlib.util
from pathlib import Path
import unittest
from urllib.parse import urlsplit, parse_qs

spec = importlib.util.spec_from_file_location("operations", Path(__file__).with_name("hourly_operations.py"))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
NOW = "2026-01-10T12:00:00Z"
CANARY = "PRIVATE_CANARY_ISSUE_CONTENT_DO_NOT_COPY"


def issue(n, **extra):
    return dict(number=n, state="open", body=CANARY, user={"type": "User", "login": CANARY}, labels=[], **extra)


def workflow(n, conclusion="failure", **extra):
    row = dict(id=n, workflow_id=7, run_number=n, run_attempt=1, event="push", head_branch="main", status="completed", conclusion=conclusion, head_repository={"id": 100})
    row.update(extra)
    return row


class Fake:
    def __init__(self):
        self.issues = {1: issue(1)}
        self.comments = {}
        self.events = {}
        self.runs = []
        self.labels = []
        self.calls = []
        self.fail = None
        self.branch = "main"
        self.comment_crash = False

    def call(self, method, path, data=None):
        self.calls.append((method, path, copy.deepcopy(data)))
        if self.fail and self.fail(method, path):
            raise m.SafeError("github_http_403")
        parts = urlsplit(path)
        name = parts.path
        query = parse_qs(parts.query)
        page = int(query.get("page", [1])[0])
        size = int(query.get("per_page", [100])[0])
        def paged(rows):
            return copy.deepcopy(rows[(page-1)*size:page*size])
        if method == "GET":
            if name == "":
                return {"default_branch": self.branch}
            if name == "/labels":
                return paged(self.labels)
            if name == "/issues":
                if "creator" in query:
                    return paged([i for i in self.issues.values() if i["user"].get("login") == m.BOT["login"]])
                return paged(sorted([i for i in self.issues.values() if i["state"] == "open"], key=lambda i: i["number"]))
            if name == "/actions/runs":
                return {"workflow_runs": paged(self.runs)}
            if name.startswith("/actions/runs/"):
                return copy.deepcopy(next(r for r in self.runs if r["id"] == int(name.split('/')[-1])))
            if name.endswith("/comments"):
                return paged(self.comments.get(int(name.split('/')[2]), []))
            if name.endswith("/events"):
                return paged(self.events.get(int(name.split('/')[2]), []))
            return copy.deepcopy(self.issues[int(name.split('/')[2])])
        if method == "POST":
            if name == "/issues":
                n = max(self.issues, default=0) + 1
                self.issues[n] = dict(number=n, state="open", user=copy.deepcopy(m.BOT), labels=[], **data)
                return copy.deepcopy(self.issues[n])
            if name == "/labels":
                self.labels.append(data)
                return data
            n = int(name.split('/')[2])
            if name.endswith("/labels"):
                self.issues[n]["labels"] = [{"name": v} for v in data["labels"]]
                return []
            self.comments.setdefault(n, []).append({"body": data["body"], "user": copy.deepcopy(m.BOT)})
            if self.comment_crash:
                self.comment_crash = False
                raise m.SafeError("github_transport_or_json")
            return {}
        if method == "PATCH":
            self.issues[int(name.split('/')[2])].update(data)
            return {}
        raise AssertionError((method, path))

    def queue(self):
        return next(i for i in self.issues.values() if m.bot(i) and i["body"].startswith(m.QUEUE))

    def state(self):
        return m.read_state(self.queue()["body"])


class OperationsTest(unittest.TestCase):
    def test_ack_dedupe_and_safe_output(self):
        f = Fake()
        f.comments[1] = [{"body": m.ACK + CANARY, "user": {"login": m.BOT["login"], "id": 9, "type": "Bot"}}]
        m.run(f, "example/demo", NOW)
        m.run(f, "example/demo", NOW)
        self.assertEqual(2, len(f.comments[1]))
        self.assertEqual([1], f.state()["pending"])
        writes = str([c for c in f.calls if c[0] != "GET"])
        self.assertNotIn(CANARY, writes)
        self.assertEqual(1, len([i for i in f.issues.values() if m.bot(i)]))

    def test_comment_committed_then_connection_lost(self):
        f = Fake()
        f.comment_crash = True
        with self.assertRaises(m.SafeError):
            m.run(f, "example/demo", NOW)
        self.assertIn("not yet completed", f.queue()["body"])
        m.run(f, "example/demo", NOW)
        self.assertEqual(1, len(f.comments[1]))
        self.assertEqual([1], f.state()["pending"])

    def test_close_reopen_and_maintainer_triage(self):
        f = Fake()
        m.run(f, "example/demo", NOW)
        f.issues[1]["labels"] = []
        f.events[1] = [{"id": 1, "event": "unlabeled", "label": {"name": m.LABEL}}]
        m.run(f, "example/demo", NOW)
        self.assertEqual([], f.state()["pending"])
        f.issues[1]["state"] = "closed"
        m.run(f, "example/demo", NOW)
        f.issues[1]["state"] = "open"
        f.events[1].append({"id": 2, "event": "reopened"})
        f.queue()["state"] = "closed"
        m.run(f, "example/demo", NOW)
        self.assertEqual([1], f.state()["pending"])
        self.assertEqual("open", f.queue()["state"])
        self.assertEqual(1, len(f.comments[1]))

    def test_queue_spoof_is_user_issue(self):
        f = Fake()
        f.issues[1]["body"] = m.QUEUE
        m.run(f, "example/demo", NOW)
        self.assertNotEqual(1, f.queue()["number"])
        self.assertEqual([1], f.state()["pending"])

    def test_pagination_and_rotating_issue_scan(self):
        f = Fake()
        f.issues = {n: issue(n) for n in range(1, 112)}
        for _ in range(3):
            m.run(f, "example/demo", NOW)
        self.assertEqual(111, len(f.state()["pending"]))
        f.runs = [workflow(n, "success") for n in range(100, 201)]
        m.run(f, "example/demo", NOW)
        self.assertTrue(any("page=2" in c[1] and "/actions/runs?" in c[1] for c in f.calls))

    def test_scan_failure_keeps_success_timestamp(self):
        f = Fake()
        m.run(f, "example/demo", NOW)
        old = f.queue()["body"]
        f.fail = lambda method, path: path.startswith("/actions/runs?")
        with self.assertRaises(m.SafeError):
            m.run(f, "example/demo", "2026-01-10T13:00:00Z")
        self.assertEqual(old, f.queue()["body"])

    def test_pagination_budget_is_failure(self):
        f = Fake()
        f.runs = [workflow(n, "success") for n in range(1, 501)]
        with self.assertRaisesRegex(m.SafeError, "pagination_budget"):
            m.run(f, "example/demo", NOW)

    def test_matching_workflow_branch_event_attempt_and_recovery(self):
        f = Fake()
        f.runs = [workflow(10)]
        m.run(f, "example/demo", NOW)
        for r in (workflow(11, "success", workflow_id=8), workflow(12, "success", head_branch="topic"), workflow(13, "success", event="schedule")):
            f.runs.append(r)
        m.run(f, "example/demo", NOW)
        self.assertEqual("failure", f.state()["failures"][0]["status"])
        f.runs[0] = workflow(10, "success", run_attempt=2)
        m.run(f, "example/demo", NOW)
        row = f.state()["failures"][0]
        self.assertEqual((10, 1, "recovered", 10), (row["id"], row["attempt"], row["status"], row["recovery"]))

    def test_cancel_and_in_progress_and_self_failure(self):
        f = Fake()
        f.runs = [workflow(10, "cancelled"), workflow(20, "timed_out", workflow_id=99, event="schedule"), workflow(30, None, status="in_progress", workflow_id=33)]
        m.run(f, "example/demo", NOW)
        rows = f.state()["failures"]
        self.assertEqual(2, len(rows))
        f.runs.append(workflow(11, None, status="in_progress"))
        m.run(f, "example/demo", NOW)
        self.assertEqual("superseded", next(r for r in f.state()["failures"] if r["id"] == 10)["status"])
        self.assertEqual("timed_out", next(r for r in f.state()["failures"] if r["id"] == 20)["status"])

    def test_default_branch_change_does_not_recover_old_branch(self):
        f = Fake()
        f.runs = [workflow(10)]
        m.run(f, "example/demo", NOW)
        f.branch = "new-default"
        f.runs = [workflow(10), workflow(11, "success", head_branch="new-default")]
        m.run(f, "example/demo", NOW)
        self.assertEqual("failure", f.state()["failures"][0]["status"])

    def test_pull_request_approval_and_fork_scope(self):
        f = Fake()
        f.runs = [workflow(40, "action_required", event="pull_request", head_branch="topic", head_repository={"id": 101}, pull_requests=[{"number": 1}])]
        m.run(f, "example/demo", NOW)
        self.assertIn("awaiting maintainer approval (not a test failure)", f.queue()["body"])
        for extra in ({"event": "push", "head_repository": {"id": 101}, "pull_requests": [{"number": 1}]},
                      {"event": "pull_request", "head_repository": {"id": 102}, "pull_requests": [{"number": 1}]},
                      {"event": "pull_request", "head_repository": {"id": 101}, "pull_requests": [{"number": 2}]}):
            f.runs.append(workflow(41, "success", head_branch="topic", **extra))
            m.run(f, "example/demo", NOW)
            self.assertEqual("action_required", f.state()["failures"][0]["status"])
            f.runs.pop()
        f.runs.append(workflow(42, "success", event="pull_request", head_branch="topic", head_repository={"id": 101}, pull_requests=[{"number": 1}]))
        m.run(f, "example/demo", NOW)
        self.assertEqual("recovered", f.state()["failures"][0]["status"])
        self.assertFalse(any(c[0] == "POST" and "/actions/" in c[1] for c in f.calls))

    def test_null_source_is_conservative_and_pending_approval_status(self):
        f = Fake()
        f.runs = [workflow(50, None, status="action_required", event="pull_request", head_repository=None)]
        m.run(f, "example/demo", NOW)
        self.assertEqual("action_required", f.state()["failures"][0]["status"])
        f.runs.append(workflow(51, "success", event="pull_request", head_repository=None))
        m.run(f, "example/demo", NOW)
        self.assertEqual("action_required", f.state()["failures"][0]["status"])
        f.runs[0] = workflow(50, "success", run_attempt=2, event="pull_request", head_repository=None)
        m.run(f, "example/demo", NOW)
        self.assertEqual("recovered", f.state()["failures"][0]["status"])

    def test_same_attempt_approval_terminal_updates(self):
        f = Fake()
        f.runs = [workflow(60, "action_required", event="pull_request")]
        m.run(f, "example/demo", NOW)
        f.runs[0] = workflow(60, "failure", event="pull_request")
        m.run(f, "example/demo", NOW)
        row = f.state()["failures"][0]
        self.assertEqual("action_required", row["original"])
        self.assertEqual("failure", row["status"])
        f.runs[0] = workflow(60, "success", event="pull_request")
        m.run(f, "example/demo", NOW)
        row = f.state()["failures"][0]
        self.assertEqual(("action_required", "recovered", 60), (row["original"], row["status"], row["recovery"]))

    def test_state_rejects_unknown_untrusted_text(self):
        state = m.empty_state()
        state["extra"] = CANARY
        with self.assertRaises(m.SafeError):
            m.read_state(m.render(state, "example/demo", NOW))

    def test_errors_do_not_echo_environment_or_exception(self):
        output = io.StringIO()
        with mock.patch.dict(m.os.environ, {"GITHUB_REPOSITORY": "example/demo", "GITHUB_TOKEN": CANARY}), mock.patch.object(m, "run", side_effect=RuntimeError(CANARY)), contextlib.redirect_stdout(output):
            self.assertEqual(1, m.main())
        self.assertNotIn(CANARY, output.getvalue())
        self.assertIn("unexpected_error", output.getvalue())
        with self.assertRaises(m.SafeError):
            m.API("https://evil.invalid/" + CANARY, CANARY)
        api = m.API("example/demo", CANARY)
        api.calls = 800
        with self.assertRaisesRegex(m.SafeError, "request_budget_exhausted"):
            api.call("GET", "")

    def test_bot_issues_and_prs_ignored(self):
        f = Fake()
        f.issues[1]["user"] = {"type": "Bot"}
        f.issues[3] = issue(3, pull_request={})
        m.run(f, "example/demo", NOW)
        self.assertEqual([], f.state()["pending"])
        self.assertEqual({}, f.comments)


if __name__ == "__main__":
    unittest.main()
