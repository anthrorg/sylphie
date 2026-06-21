#!/usr/bin/env python3
"""Deterministic ready-ticket picker for the worktree-agents-parallel workflow.

Mirrors planning-worx's canonical readiness logic (state_digest.js compute()):
a ticket is READY when its status is todo|backlog and every id in its depends_on
is status=="done". Sorted by priority (P1<P2<P3) then trailing id number, exactly
like /plan-status. Emits the top-N ready tickets as a JSON array with the fields
the build step needs — so no LLM has to parse the 5k-line contract to pick work.

Usage: python pick_ready.py [--limit N] [--contract PATH]
"""
import argparse, json, re, sys

try:
    import yaml
except ImportError:
    print(json.dumps({"error": "pyyaml not available"}), file=sys.stderr)
    sys.exit(1)

PRIO_RANK = {"P1": 1, "P2": 2, "P3": 3}


def id_num(tid):
    m = re.search(r"-(\d+)$", tid or "")
    return int(m.group(1)) if m else 0


def slugify(title):
    words = re.sub(r"[^a-z0-9\s-]", "", (title or "").lower()).split()
    return "-".join(words[:5])[:40] or "work"


def flatten_ac(ac):
    """Flatten acceptance_criteria entries to plain strings."""
    out = []
    for c in ac or []:
        if isinstance(c, dict) and ("given" in c or "when" in c or "then" in c):
            out.append("Given {given}, when {when}, then {then}".format(
                given=c.get("given", ""), when=c.get("when", ""), then=c.get("then", "")))
        else:
            out.append(str(c))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=10)
    ap.add_argument("--contract", default="planning/contract.yaml")
    args = ap.parse_args()

    with open(args.contract, "r", encoding="utf-8") as f:
        doc = yaml.safe_load(f)

    nodes = doc.get("nodes", []) or []
    status_by = {n["id"]: n.get("status") for n in nodes if n.get("id")}

    def is_done(i):
        return status_by.get(i) == "done"

    tickets = [n for n in nodes if n.get("kind") == "ticket"]
    ready = [
        t for t in tickets
        if t.get("status") in ("todo", "backlog")
        and all(is_done(d) for d in (t.get("depends_on") or []))
    ]
    ready.sort(key=lambda t: (PRIO_RANK.get(t.get("priority"), 9), id_num(t["id"])))

    batch = []
    for t in ready[: args.limit]:
        batch.append({
            "ticketId": t["id"],
            "ticketTitle": t.get("title", ""),
            "ticketSlug": slugify(t.get("title", "")),
            "priority": t.get("priority"),
            "description": t.get("intent", "") or "See acceptance criteria.",
            "acceptanceCriteria": flatten_ac(t.get("acceptance_criteria")),
            "engineeringLevel": t.get("engineering_level", "mvp"),
            "filesInScope": t.get("files_in_scope", []) or [],
            "testRefs": t.get("test_refs", []) or [],
            "parentEpic": t.get("parent"),
            "dependsOn": t.get("depends_on", []) or [],
        })

    print(json.dumps({"tickets": batch}, ensure_ascii=False))


if __name__ == "__main__":
    main()
