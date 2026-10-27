"""Bounded GitHub-only issue acknowledgement and default-branch run tracking."""
import datetime as dt
import json
import hashlib
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

BOT = {"login": "github-actions[bot]", "id": 41898282, "type": "Bot"}
QUEUE = "<!-- hourly-operations:queue:v1 -->"
ACK = "<!-- hourly-operations:ack:v1 -->"
LABEL = "needs-triage"
ACK_BODY = ACK + "\nThanks for your report. It is queued for maintainer triage. This automated acknowledgement does not mean it has been reviewed or fixed. Please avoid posting credentials or private data."
EVENTS = {"push", "schedule", "workflow_dispatch", "pull_request", "pull_request_target", "workflow_run", "merge_group"}
BAD = {"failure", "timed_out", "action_required", "startup_failure", "stale", "cancelled"}


class SafeError(Exception):
    pass


def bot(item):
    user = item.get("user", {})
    return all(user.get(k) == v for k, v in BOT.items())


class API:
    def __init__(self, repo, token):
        if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repo):
            raise SafeError("invalid_repository")
        self.root = "https://api.github.com/repos/" + repo
        self.token = token
        self.calls = 0

    def call(self, method, path, data=None):
        self.calls += 1
        if self.calls > 800:
            raise SafeError("request_budget_exhausted")
        request = urllib.request.Request(self.root + path,
            data=json.dumps(data).encode() if data is not None else None,
            headers={"Authorization": "Bearer " + self.token,
                     "Accept": "application/vnd.github+json", "Content-Type": "application/json",
                     "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "hourly-operations"}, method=method)
        try:
            # Never forward authorization across redirects.
            class NoRedirect(urllib.request.HTTPRedirectHandler):
                def redirect_request(self, *args, **kwargs):
                    return None
            with urllib.request.build_opener(NoRedirect).open(request, timeout=15) as response:
                raw = response.read(2_000_001)
                if len(raw) > 2_000_000:
                    raise SafeError("response_budget_exhausted")
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as error:
            raise SafeError("github_http_" + str(error.code)) from None
        except (OSError, ValueError):
            raise SafeError("github_transport_or_json") from None


def pages(api, path, key=None, limit=5):
    rows = []
    for page in range(1, limit + 1):
        result = api.call("GET", path + ("&" if "?" in path else "?") + f"per_page=100&page={page}")
        batch = result[key] if key else result
        rows.extend(batch)
        if len(batch) < 100:
            return rows
    raise SafeError("pagination_budget_exhausted")


def scope_key(run):
    # Scope contains no copied branch text; fork branches must not recover each other.
    source = (run.get("head_repository") or {}).get("id")
    scope = [run.get("head_branch"), source if source is not None and run.get("head_branch") else ["unknown", run["id"]],
             sorted(p["number"] for p in (run.get("pull_requests") or []))]
    return hashlib.sha256(json.dumps(scope, sort_keys=True).encode()).hexdigest()


def empty_state():
    return {"version": 1, "cursor": 1, "pending": [], "failures": []}


def read_state(body):
    try:
        raw = re.search(r"<!-- state:(\{[^\n]+\}) -->", body).group(1)
        state = json.loads(raw)
        assert set(state) == {"version", "cursor", "pending", "failures"}
        assert state["version"] == 1 and type(state["cursor"]) is int and 1 <= state["cursor"] <= 100000
        assert len(state["pending"]) <= 200 and len(state["failures"]) <= 100
        assert all(type(n) is int and n > 0 for n in state["pending"])
        for row in state["failures"]:
            assert set(row) == {"id", "attempt", "workflow", "number", "event", "status", "recovery", "branch", "original"}
            assert all(type(row[k]) is int and row[k] > 0 for k in ("id", "attempt", "workflow", "number"))
            assert type(row["recovery"]) is int and row["recovery"] >= 0
            assert re.fullmatch(r"[a-f0-9]{64}", row["branch"])
            assert row["original"] in BAD
            assert row["event"] in EVENTS and row["status"] in BAD | {"recovered", "superseded"}
        return state
    except (AssertionError, ValueError, KeyError, TypeError, AttributeError):
        raise SafeError("queue_state_invalid") from None


def render(state, repo, now):
    root = "https://github.com/" + repo
    lines = [QUEUE, "# Maintainer operations queue", "", "Last successful check: " + now,
        "", "Open items require maintainer decisions. Acknowledgement is not resolution.",
        "Remove `needs-triage` after triage; close resolved user issues. Reopened issues return to this queue.",
        "The automation reopens this queue. Do not edit its machine state.",
        "", "## Issue triage (open)"]
    lines += [f"- [Issue #{n}]({root}/issues/{n})" for n in sorted(state["pending"])] or ["- No pending triage in the last completed scan."]
    lines += ["", "## Actions (branches and pull requests)",
        "Failure history is bounded to 100 records. Recovered records are retained until capacity is needed.",
        "Cancellation without a known newer run requires review. Superseded cancellation is informational; its cause is unverified."]
    for row in state["failures"]:
        category = "awaiting maintainer approval (not a test failure)" if row["status"] == "action_required" else row["status"]
        lines.append(f"- [{category}; originally {row['original']}] [Run {row['id']}, attempt {row['attempt']}]({root}/actions/runs/{row['id']}/attempts/{row['attempt']}) | workflow {row['workflow']} | {row['event']}" +
                     (f" | [successor]({root}/actions/runs/{row['recovery']})" if row["recovery"] else ""))
    if not state["failures"]:
        lines.append("- No tracked failures in the bounded scan.")
    lines += ["", "Coverage: recent seven days plus individually tracked unresolved runs; up to 500 recent runs.",
              "Issue scan: up to 50 open issues per pass with a persistent rotating page; pending items rechecked each pass.",
              "This timestamp advances only after a completed pass; a stale timestamp needs manual investigation.",
              "", "<!-- state:" + json.dumps(state, separators=(",", ":"), sort_keys=True) + " -->"]
    body = "\n".join(lines)
    if len(body.encode()) > 60000:
        raise SafeError("queue_body_budget_exhausted")
    return body


def run(api, repo, now):
    metadata = api.call("GET", "")
    if metadata.get("private") is True:
        raise SafeError("public_repository_required")
    queues = [i for i in pages(api, "/issues?state=all&creator=github-actions%5Bbot%5D")
              if bot(i) and i.get("body", "").startswith(QUEUE) and "pull_request" not in i]
    if len(queues) > 1:
        raise SafeError("ambiguous_queue")
    queue = queues[0] if queues else None
    state = read_state(queue["body"]) if queue else empty_state()
    if not queue:
        queue = api.call("POST", "/issues", {"title": "Maintainer operations queue", "body": render(state, repo, "not yet completed")})
    number = queue["number"]
    # Ensure a generic label exists; never overwrite maintainer label attributes.
    labels = pages(api, "/labels")
    if not any(i["name"] == LABEL for i in labels):
        api.call("POST", "/labels", {"name": LABEL, "color": "d4c5f9", "description": "Awaiting maintainer triage"})

    # A rotating created-order page bounds work without permanently starving older issues.
    batch = api.call("GET", f"/issues?state=open&sort=created&direction=asc&per_page=50&page={state['cursor']}")
    pending = set(state["pending"])
    selected = {i["number"]: i for i in batch}
    for n in list(pending):
        if n not in selected:
            selected[n] = api.call("GET", f"/issues/{n}")
    for n, issue in selected.items():
        if n == number or "pull_request" in issue or issue.get("user", {}).get("type") == "Bot":
            continue
        if issue["state"] != "open":
            pending.discard(n)
            continue
        comments = pages(api, f"/issues/{n}/comments", limit=3)
        acknowledged = any(bot(c) and c.get("body", "").startswith(ACK) for c in comments)
        has_label = any(label["name"] == LABEL for label in issue.get("labels", []))
        # Comments/events are inspected as data; no external text is emitted.
        events = pages(api, f"/issues/{n}/events", limit=3) if acknowledged and not has_label else []
        # Restore label after a reopen, but respect an explicit maintainer unlabel after it.
        last_reopen = max((e["id"] for e in events if e["event"] == "reopened"), default=0)
        last_remove = max((e["id"] for e in events if e["event"] == "unlabeled" and e.get("label", {}).get("name") == LABEL), default=0)
        needs = not acknowledged or has_label or last_reopen > last_remove
        if needs:
            if len(pending | {n}) > 200:
                raise SafeError("pending_budget_exhausted")
            # Label before comment: a crash after comment must not lose the triage queue.
            if not has_label:
                api.call("POST", f"/issues/{n}/labels", {"labels": [LABEL]})
            if not acknowledged:
                api.call("POST", f"/issues/{n}/comments", {"body": ACK_BODY})
            pending.add(n)
        else:
            pending.discard(n)
    state["pending"] = sorted(pending)
    state["cursor"] = state["cursor"] + 1 if len(batch) == 50 else 1

    since = (dt.datetime.fromisoformat(now.replace("Z", "+00:00")) - dt.timedelta(days=7)).strftime("%Y-%m-%dT%H:%M:%SZ")
    recent = pages(api, "/actions/runs?" + urllib.parse.urlencode({"created": ">=" + since}), "workflow_runs")
    runs = {r["id"]: r for r in recent if r.get("event") in EVENTS}
    records = {(r["id"], r["attempt"]): r for r in state["failures"]}
    for row in list(records.values()):
        if row["status"] in BAD and row["id"] not in runs:
            r = api.call("GET", f"/actions/runs/{row['id']}")
            if r.get("event") in EVENTS:
                runs[r["id"]] = r
    for r in runs.values():
        attention = r.get("conclusion") if r["status"] == "completed" else ("action_required" if r["status"] == "action_required" else None)
        if attention in BAD:
            key = (r["id"], r["run_attempt"])
            if key not in records:
                records[key] = {"id": r["id"], "attempt": r["run_attempt"], "workflow": r["workflow_id"],
                                "branch": scope_key(r), "number": r["run_number"], "event": r["event"], "original": attention, "status": attention, "recovery": 0}
            else:
                row = records[key]
                if (row["status"] in BAD and row["workflow"] == r["workflow_id"] and
                        row["event"] == r["event"] and row["branch"] == scope_key(r)):
                    row["status"] = attention
    for row in records.values():
        if row["status"] not in BAD:
            continue
        successors = [r for r in runs.values() if r["workflow_id"] == row["workflow"] and r["event"] == row["event"] and scope_key(r) == row["branch"] and
                      (r["run_number"] > row["number"] or (r["id"] == row["id"] and (r["run_attempt"] > row["attempt"] or
                       (r["run_attempt"] == row["attempt"] and r["status"] == "completed" and r["conclusion"] == "success"))))]
        successes = [r for r in successors if r["status"] == "completed" and r["conclusion"] == "success"]
        if successes:
            row["status"] = "recovered"
            row["recovery"] = max(successes, key=lambda r: (r["run_number"], r["run_attempt"]))["id"]
        elif row["status"] == "cancelled" and successors:
            row["status"] = "superseded"
            row["recovery"] = max(successors, key=lambda r: (r["run_number"], r["run_attempt"]))["id"]
    ordered = sorted(records.values(), key=lambda r: (r["id"], r["attempt"]), reverse=True)
    unresolved = [r for r in ordered if r["status"] in BAD]
    if len(unresolved) > 100:
        raise SafeError("failure_budget_exhausted")
    state["failures"] = unresolved + [r for r in ordered if r["status"] not in BAD][:100-len(unresolved)]
    api.call("PATCH", f"/issues/{number}", {"body": render(state, repo, now), "state": "open"})
    return {"result": "completed", "pending": len(pending), "tracked": len(state["failures"]), "queue": number}


def main():
    try:
        result = run(API(os.environ["GITHUB_REPOSITORY"], os.environ["GITHUB_TOKEN"]),
                     os.environ["GITHUB_REPOSITORY"], dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"))
        print(json.dumps(result, sort_keys=True))
    except SafeError as error:
        print(json.dumps({"result": "failed", "code": str(error)}))
        return 1
    except Exception:
        # Do not print API bodies, headers, environment, issue content or tracebacks.
        print('{"result":"failed","code":"unexpected_error"}')
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
