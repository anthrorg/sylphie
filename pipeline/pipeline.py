#!/usr/bin/env python3
"""pipeline.py — deterministic state machine for the markdown intake pipeline."""
import argparse
import datetime as dt
import json
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
INDEX = ROOT / "pipeline.json"
CONFIG = ROOT / "config.json"
STATES = ["inbox", "planning", "refine", "queue", "working",
          "review", "refactor", "replan", "done", "archive"]
TRANSITIONS = {
    "inbox": {"planning"},
    "planning": {"refine", "replan"},
    "refine": {"queue", "replan"},
    "queue": {"working", "replan"},
    "working": {"review", "refactor", "replan"},
    "review": {"done", "refactor", "replan"},
    "refactor": {"queue", "replan"},
    "replan": {"planning", "queue"},
    "done": {"archive"},
    "archive": set(),
}
BLOCKED_STATES = {"replan", "refactor"}


def now() -> str:
    return dt.datetime.now().astimezone().isoformat(timespec="seconds")


def load_config() -> dict:
    try:
        return json.loads(CONFIG.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}


def today_prefix() -> str:
    return dt.datetime.now().strftime(load_config().get("id_prefix_format", "%Y%m%d"))


def load_index() -> dict:
    try:
        return json.loads(INDEX.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {"version": 1, "next_seq": {}, "items": {}}


def save_index(idx: dict) -> None:
    INDEX.write_text(json.dumps(idx, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def slugify(text: str) -> str:
    words = re.sub(r"[^a-z0-9\s-]", "", (text or "").lower()).split()
    return "-".join(words[:6])[:48] or "item"


def first_heading(md: str) -> str:
    for line in md.splitlines():
        s = line.strip()
        if s.startswith("#"):
            return s.lstrip("#").strip()
        if s:
            return s[:80]
    return ""


def guess_type(name: str, md: str) -> str:
    """Cheap, HONEST hint only. Returns a label only when exactly one category
    matches cleanly; ambiguous/rich docs return 'unclassified'. The plan cog is the
    real classifier — nothing branches on this field."""
    hay = (name + "\n" + md[:800]).lower()
    cats = []
    if re.search(r"\bbug\b|\bfix\b|broken|regression|crash|fails?\b", hay):
        cats.append("bug")
    if re.search(r"\bfeature\b|\bepic\b|\badd \b|implement |support ", hay):
        cats.append("feature")
    if re.search(r"\bchore\b|refactor|cleanup|rename|bump|upgrade", hay):
        cats.append("chore")
    return cats[0] if len(cats) == 1 else "unclassified"


def item_dir(idx: dict, item_id: str) -> Path:
    rec = idx["items"][item_id]
    return ROOT / rec["state"] / rec["namespace"]


def append_log(d: Path, line: str) -> None:
    with (d / "log.md").open("a", encoding="utf-8") as f:
        f.write(f"- `{now()}` {line}\n")


def cmd_ingest(args):
    idx = load_index()
    created = []
    for src in sorted((ROOT / "inbox").glob("*.md")):
        if src.name == ".gitkeep":
            continue
        md = src.read_text(encoding="utf-8", errors="replace")
        n_lines = md.count("\n") + 1
        n_sections = sum(1 for ln in md.splitlines() if ln.lstrip().startswith("#"))
        size_hint = "large" if (n_sections >= 6 or n_lines >= 150) else "small"
        title = first_heading(md) or src.stem.replace("-", " ").title()
        slug = slugify(title if first_heading(md) else src.stem)
        prefix = today_prefix()
        seq = idx["next_seq"].get(prefix, 0) + 1
        idx["next_seq"][prefix] = seq
        item_id = f"{prefix}-{seq:03d}"
        namespace = f"{item_id}-{slug}"
        dest = ROOT / "planning" / namespace
        dest.mkdir(parents=True, exist_ok=False)
        shutil.move(str(src), str(dest / "source.md"))
        rec = {
            "id": item_id, "slug": slug, "title": title,
            "type": guess_type(src.name, md), "size_hint": size_hint,
            "lines": n_lines, "sections": n_sections, "state": "planning",
            "namespace": namespace, "source_file": src.name,
            "created_at": now(), "updated_at": now(),
            "attempts": 0, "refactor_attempts": 0,
            "contract_nodes": [], "blocked_reason": None,
            "history": [{"at": now(), "from": "inbox", "to": "planning", "note": "ingested"}],
        }
        idx["items"][item_id] = rec
        (dest / "item.json").write_text(json.dumps(rec, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        append_log(dest, f"**ingested** from `inbox/{src.name}` -> planning/ (type guess: {rec['type']})")
        created.append(rec)
    save_index(idx)
    print(json.dumps({"ingested": created}, indent=2, ensure_ascii=False))


def _sync_item_json(idx, item_id):
    d = item_dir(idx, item_id)
    (d / "item.json").write_text(json.dumps(idx["items"][item_id], indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def cmd_move(args):
    idx = load_index()
    rec = idx["items"].get(args.id)
    if not rec:
        sys.exit(f"unknown item: {args.id}")
    frm = rec["state"]
    to = args.state
    if to not in STATES:
        sys.exit(f"unknown state: {to}")
    legal = to in TRANSITIONS.get(frm, set())
    if not legal and not args.force:
        sys.exit(f"illegal transition {frm} -> {to} (use --force with a --reason to override)")
    src = ROOT / frm / rec["namespace"]
    dst = ROOT / to / rec["namespace"]
    if not src.exists():
        sys.exit(f"item folder missing on disk: {src}")
    (ROOT / to).mkdir(parents=True, exist_ok=True)
    shutil.move(str(src), str(dst))
    rec["state"] = to
    rec["updated_at"] = now()
    if to == "replan":
        rec["attempts"] = rec.get("attempts", 0) + 1
        rec["blocked_reason"] = args.reason or args.note or "unspecified"
    elif to == "refactor":
        rec["refactor_attempts"] = rec.get("refactor_attempts", 0) + 1
        rec["blocked_reason"] = args.reason or args.note or "unspecified"
    else:
        rec["blocked_reason"] = None
    note = args.reason or args.note or ""
    rec["history"].append({"at": now(), "from": frm, "to": to, "note": note})
    save_index(idx)
    _sync_item_json(idx, args.id)
    label = "" if legal else "**FORCED** "
    append_log(dst, f"{label}moved **{frm} -> {to}**" + (f" — {note}" if note else ""))
    print(json.dumps({"id": args.id, "state": to, "namespace": rec["namespace"], "path": str(dst)}, indent=2))


def cmd_log(args):
    idx = load_index()
    rec = idx["items"].get(args.id)
    if not rec:
        sys.exit(f"unknown item: {args.id}")
    append_log(item_dir(idx, args.id), args.message)
    rec["updated_at"] = now()
    save_index(idx)
    _sync_item_json(idx, args.id)
    print(f"logged to {item_dir(idx, args.id) / 'log.md'}")


def cmd_set(args):
    idx = load_index()
    rec = idx["items"].get(args.id)
    if not rec:
        sys.exit(f"unknown item: {args.id}")
    if args.type:
        rec["type"] = args.type
    if args.title:
        rec["title"] = args.title
    if args.add_node:
        for n in args.add_node:
            if n not in rec["contract_nodes"]:
                rec["contract_nodes"].append(n)
    if args.attempts is not None:
        rec["attempts"] = args.attempts
    rec["updated_at"] = now()
    save_index(idx)
    _sync_item_json(idx, args.id)
    print(json.dumps(rec, indent=2, ensure_ascii=False))


def cmd_show(args):
    idx = load_index()
    rec = idx["items"].get(args.id)
    if not rec:
        sys.exit(f"unknown item: {args.id}")
    print(json.dumps(rec, indent=2, ensure_ascii=False))


def cmd_list(args):
    idx = load_index()
    items = list(idx["items"].values())
    if args.state:
        items = [r for r in items if r["state"] == args.state]
    items.sort(key=lambda r: r["id"])
    out = [{"id": r["id"], "state": r["state"], "type": r["type"], "title": r["title"],
            "attempts": r.get("attempts", 0), "refactor_attempts": r.get("refactor_attempts", 0),
            "nodes": r.get("contract_nodes", [])} for r in items]
    print(json.dumps(out, indent=2, ensure_ascii=False))


def cmd_status(args):
    idx = load_index()
    cfg = load_config()
    counts = {s: 0 for s in STATES}
    for r in idx["items"].values():
        counts[r["state"]] = counts.get(r["state"], 0) + 1
    mr = cfg.get("max_replan_attempts", 2)
    mf = cfg.get("max_refactor_attempts", 2)
    parked = [r["id"] for r in idx["items"].values()
              if (r["state"] == "replan" and r.get("attempts", 0) >= mr)
              or (r["state"] == "refactor" and r.get("refactor_attempts", 0) >= mf)]
    print(json.dumps({"counts": counts, "total": len(idx["items"]), "parked_at_max_attempts": parked}, indent=2, ensure_ascii=False))


def cmd_stuck(args):
    idx = load_index()
    hours = args.hours if args.hours is not None else load_config().get("stuck_threshold_hours", 48)
    cutoff = dt.datetime.now().astimezone() - dt.timedelta(hours=hours)
    stuck = []
    for r in idx["items"].values():
        if r["state"] in ("done", "archive"):
            continue
        try:
            updated = dt.datetime.fromisoformat(r["updated_at"])
        except (ValueError, KeyError):
            continue
        if updated < cutoff:
            stuck.append({"id": r["id"], "state": r["state"], "title": r["title"],
                          "updated_at": r["updated_at"], "blocked_reason": r.get("blocked_reason")})
    stuck.sort(key=lambda x: x["updated_at"])
    print(json.dumps({"threshold_hours": hours, "stuck": stuck}, indent=2, ensure_ascii=False))


DB_SURFACE_PATTERNS = [
    r"infra/(postgres|timescaledb)/init/", r"infra/migrations/",
    r"prisma/schema\.prisma", r"prisma/migrations/", r"\.sql\b", r"\.cypher\b",
]
DB_KEYWORDS = ["neo4j", "timescale", "postgres", "pgvector", "vector(", "embedding_dim",
               "embedding dim", "hypertable", "cypher", "prisma", "alter table",
               "alter column", "add column", "create table", "drop table", "migration"]


def cmd_dbcheck(args):
    idx = load_index()
    rec = idx["items"].get(args.id)
    if not rec:
        sys.exit(f"unknown item: {args.id}")
    repo_root = ROOT.parent
    cfg = load_config()
    contract = repo_root / cfg.get("contract_path", "planning/contract.yaml")
    files = []
    nodes = set(rec.get("contract_nodes") or [])
    if nodes:
        try:
            import yaml
            doc = yaml.safe_load(contract.read_text(encoding="utf-8")) or {}
            for n in doc.get("nodes", []) or []:
                if n.get("id") in nodes:
                    files.extend(n.get("files_in_scope") or [])
        except Exception:
            pass
    surfaces = [f for f in files if any(re.search(p, str(f).replace("\\", "/"), re.IGNORECASE) for p in DB_SURFACE_PATTERNS)]
    d = item_dir(idx, args.id)
    text = ""
    for name in ("source.md", "plan.md"):
        p = d / name
        if p.exists():
            text += p.read_text(encoding="utf-8", errors="replace").lower()
    kw_hits = sorted({k for k in DB_KEYWORDS if k in text})
    touches = bool(surfaces) or bool(kw_hits)
    has_plan = (d / "migration.md").exists()
    verdict = {"id": args.id, "touches_db": touches, "surface_files": surfaces,
               "keyword_hits": kw_hits, "has_migration_plan": has_plan,
               "ok": (not touches) or has_plan}
    if touches and not has_plan:
        verdict["action"] = "BLOCK: write migration.md from policies/migration-plan.template.md and route to sentinel before queue or done."
    print(json.dumps(verdict, indent=2, ensure_ascii=False))


def build_parser():
    p = argparse.ArgumentParser(description="Deterministic state machine for the markdown intake pipeline.")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("ingest").set_defaults(func=cmd_ingest)
    m = sub.add_parser("move")
    m.add_argument("id"); m.add_argument("state")
    m.add_argument("--note", default=""); m.add_argument("--reason", default="")
    m.add_argument("--force", action="store_true")
    m.set_defaults(func=cmd_move)
    lg = sub.add_parser("log"); lg.add_argument("id"); lg.add_argument("message"); lg.set_defaults(func=cmd_log)
    st = sub.add_parser("set"); st.add_argument("id")
    st.add_argument("--type"); st.add_argument("--title")
    st.add_argument("--add-node", nargs="*", dest="add_node"); st.add_argument("--attempts", type=int)
    st.set_defaults(func=cmd_set)
    sh = sub.add_parser("show"); sh.add_argument("id"); sh.set_defaults(func=cmd_show)
    ls = sub.add_parser("list"); ls.add_argument("--state"); ls.set_defaults(func=cmd_list)
    sub.add_parser("status").set_defaults(func=cmd_status)
    sk = sub.add_parser("stuck"); sk.add_argument("--hours", type=int); sk.set_defaults(func=cmd_stuck)
    dc = sub.add_parser("dbcheck"); dc.add_argument("id"); dc.set_defaults(func=cmd_dbcheck)
    return p


if __name__ == "__main__":
    a = build_parser().parse_args()
    a.func(a)
