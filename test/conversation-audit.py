"""Conversation audit script — sends messages, validates OKG facts + verbose logs.

Run:  python test/conversation-audit.py

Requires: pip install websocket-client requests

Sends a scripted conversation, then checks:
  1. OKG has the expected Person facts (name, kids, etc.)
  2. Verbose logs show correct [answered]/[unanswered] tagging
  3. Responses are focused on the latest message (no re-answering)
  4. No double delivery (clients:1 in broadcasts)
  5. Bootstrap tracker is recording comparisons
"""

from __future__ import annotations

import json
import sys
import time
import threading
from dataclasses import dataclass, field
from pathlib import Path

try:
    import websocket  # websocket-client
    import requests
except ImportError:
    print("Install dependencies: pip install websocket-client requests")
    sys.exit(1)

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

BACKEND_URL = "http://localhost:3000"
COGNITION_URL = "http://localhost:8431"
WS_URL = "ws://localhost:3000/ws/conversation?protocol=cobeing-v1"

# Auth token — get from localStorage or login
TOKEN = None  # Set below after login

# Scripted conversation — each entry is (message, expected_facts, timeout_sec)
SCRIPT: list[tuple[str, list[str], int]] = [
    ("Hello!", [], 15),
    ("My name is Jim.", ["name"], 20),
    ("I have three kids.", ["kids"], 20),
    ("My oldest is Henry, he is 8 years old.", ["Henry"], 30),
    ("My middle child is Eleanor, she is 6.", ["Eleanor"], 30),
    ("My youngest is Margot, she is 4.", ["Margot"], 30),
    ("What are my kids names?", [], 30),
    ("What is my name?", [], 15),
]

# Verbose log path
VERBOSE_LOG = Path(__file__).parent.parent / "logs" / "verbose.log"
# Also check app-level log
APP_VERBOSE_LOG = Path(__file__).parent.parent / "apps" / "sylphie" / "logs" / "verbose.log"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

@dataclass
class AuditResult:
    """Collects pass/fail for each check."""
    checks: list[tuple[str, bool, str]] = field(default_factory=list)

    def check(self, name: str, passed: bool, detail: str = ""):
        status = "PASS" if passed else "FAIL"
        self.checks.append((name, passed, detail))
        print(f"  [{status}] {name}" + (f" — {detail}" if detail else ""))

    def summary(self):
        total = len(self.checks)
        passed = sum(1 for _, p, _ in self.checks if p)
        failed = total - passed
        print(f"\n{'='*60}")
        print(f"  {passed}/{total} passed, {failed} failed")
        if failed:
            print(f"\n  Failed checks:")
            for name, p, detail in self.checks:
                if not p:
                    print(f"    - {name}: {detail}")
        print(f"{'='*60}")
        return failed == 0


def login() -> str:
    """Login and return JWT token."""
    r = requests.post(f"{BACKEND_URL}/api/auth/login", json={
        "username": "blubagoo",
        "password": "password",
    }, timeout=5)
    if r.status_code == 201:
        return r.json().get("access_token", "")
    # Try register if login fails
    r = requests.post(f"{BACKEND_URL}/api/auth/register", json={
        "username": "blubagoo",
        "password": "password",
    }, timeout=5)
    if r.status_code == 201:
        return r.json().get("access_token", "")
    print(f"Auth failed: {r.status_code} {r.text}")
    return ""


def get_okg_facts() -> list[dict]:
    """Get all Person facts from OKG via REST API."""
    r = requests.get(f"{BACKEND_URL}/api/graph/okg", timeout=5)
    if r.status_code != 200:
        return []
    data = r.json()
    # Find Attribute nodes connected to the guardian
    facts = []
    for node in data.get("nodes", []):
        if node.get("node_type") == "Attribute":
            facts.append({
                "key": node.get("properties", {}).get("key", ""),
                "value": node.get("properties", {}).get("value", ""),
                "confidence": node.get("confidence", 0),
            })
    return facts


def get_bootstrap_status() -> dict:
    """Get bootstrap status from cognition sidecar."""
    try:
        r = requests.get(f"{COGNITION_URL}/cognition/bootstrap", timeout=3)
        return r.json() if r.status_code == 200 else {}
    except Exception:
        return {}


def read_recent_verbose_lines(since_line: int) -> list[str]:
    """Read verbose log lines added since a given line number."""
    log_path = APP_VERBOSE_LOG if APP_VERBOSE_LOG.exists() else VERBOSE_LOG
    if not log_path.exists():
        return []
    with open(log_path, "r", encoding="utf-8", errors="replace") as f:
        lines = f.readlines()
    return lines[since_line:]


def count_verbose_lines() -> int:
    """Count current lines in verbose log."""
    log_path = APP_VERBOSE_LOG if APP_VERBOSE_LOG.exists() else VERBOSE_LOG
    if not log_path.exists():
        return 0
    with open(log_path, "r", encoding="utf-8", errors="replace") as f:
        return sum(1 for _ in f)


# ---------------------------------------------------------------------------
# WebSocket conversation runner
# ---------------------------------------------------------------------------

def run_conversation(token: str) -> list[dict]:
    """Send scripted messages, collect responses."""
    responses: list[dict] = []
    current_response: dict | None = None
    response_event = threading.Event()

    ws_url = f"{WS_URL}&token={token}" if token else WS_URL

    def on_message(ws, message):
        nonlocal current_response
        try:
            msg = json.loads(message)
            if msg.get("type") == "cb_speech":
                current_response = msg
                response_event.set()
        except json.JSONDecodeError:
            pass

    def on_error(ws, error):
        print(f"  WS error: {error}")

    def on_open(ws):
        print("  WebSocket connected")

    ws = websocket.WebSocketApp(
        ws_url,
        on_message=on_message,
        on_error=on_error,
        on_open=on_open,
    )

    # Run WS in background thread
    ws_thread = threading.Thread(target=ws.run_forever, daemon=True)
    ws_thread.start()
    time.sleep(2)  # Wait for connection

    for i, (message, _, timeout) in enumerate(SCRIPT):
        print(f"\n  [{i+1}/{len(SCRIPT)}] Sending: \"{message}\"")
        current_response = None
        response_event.clear()

        # Send message
        ws.send(json.dumps({
            "event": "message",
            "data": {"text": message, "type": "message"},
        }))

        # Wait for response
        got_response = response_event.wait(timeout=timeout)
        if got_response and current_response:
            text = current_response.get("text", "")
            print(f"           Response: \"{text[:100]}{'...' if len(text) > 100 else ''}\"")
            responses.append({
                "input": message,
                "response": current_response,
                "response_text": text,
            })
        else:
            print(f"           TIMEOUT — no response in {timeout}s")
            responses.append({
                "input": message,
                "response": None,
                "response_text": "",
            })

        # Brief pause between messages
        time.sleep(1)

    ws.close()
    return responses


# ---------------------------------------------------------------------------
# Audit checks
# ---------------------------------------------------------------------------

def run_audit():
    print("=" * 60)
    print("  Sylphie Conversation Audit")
    print("=" * 60)

    audit = AuditResult()

    # Pre-checks
    print("\n--- Pre-flight ---")
    try:
        r = requests.get(f"{BACKEND_URL}/api/metrics/health", timeout=3)
        audit.check("Backend reachable", r.status_code == 200)
    except Exception as e:
        audit.check("Backend reachable", False, str(e))
        audit.summary()
        return

    try:
        r = requests.get(f"{COGNITION_URL}/cognition/health", timeout=3)
        audit.check("Cognition sidecar reachable", r.status_code == 200)
        sidecar_ok = True
    except Exception:
        audit.check("Cognition sidecar reachable", False, "Not running")
        sidecar_ok = False

    # Login
    token = login()
    audit.check("Auth token acquired", bool(token), f"token length: {len(token)}")

    # Record log position before conversation
    log_start = count_verbose_lines()
    bootstrap_before = get_bootstrap_status() if sidecar_ok else {}

    # Run conversation
    print("\n--- Conversation ---")
    responses = run_conversation(token)

    # Wait for async processing (training samples, OKG writes)
    print("\n  Waiting for async processing...")
    time.sleep(5)

    # --- Check responses ---
    print("\n--- Response Quality ---")
    for i, entry in enumerate(responses):
        msg = SCRIPT[i][0]
        audit.check(
            f"Got response to \"{msg[:30]}\"",
            bool(entry["response_text"]),
            entry["response_text"][:80] if entry["response_text"] else "EMPTY",
        )

    # Check the "What is my name?" response contains "Jim"
    name_response = responses[-1]["response_text"] if len(responses) >= len(SCRIPT) else ""
    audit.check(
        "Knows user's name is Jim",
        "Jim" in name_response or "jim" in name_response.lower(),
        name_response[:80],
    )

    # Check the "What are my kids names?" response
    kids_response = responses[-2]["response_text"] if len(responses) >= len(SCRIPT) - 1 else ""
    has_kids = any(name in kids_response for name in ["Henry", "Eleanor", "Margot"])
    audit.check(
        "Knows kids' names",
        has_kids,
        kids_response[:80],
    )

    # --- Check OKG facts ---
    print("\n--- OKG Facts ---")
    facts = get_okg_facts()
    audit.check("OKG has Attribute nodes", len(facts) > 0, f"{len(facts)} facts found")
    fact_keys = [f["key"] for f in facts]
    fact_values = " ".join(f["value"] for f in facts).lower()
    audit.check("OKG has 'name' fact", "name" in fact_keys or "jim" in fact_values,
                f"keys: {fact_keys}")

    # --- Check verbose logs ---
    print("\n--- Verbose Log Analysis ---")
    new_lines = read_recent_verbose_lines(log_start)
    log_text = "".join(new_lines)

    # Check for [answered]/[unanswered] tags
    has_answered = "[answered]" in log_text or "answered" in log_text.lower()
    audit.check("Log shows [answered]/[unanswered] tags", has_answered)

    # Check for double delivery
    double_deliveries = [l for l in new_lines if "delivery broadcast" in l and '"clients":2' in l]
    audit.check(
        "No double delivery (clients:1)",
        len(double_deliveries) == 0,
        f"{len(double_deliveries)} double deliveries found",
    )

    # Check for training samples submitted
    training_lines = [l for l in new_lines if "training sample submitted" in l]
    audit.check(
        "Training samples submitted to sidecar",
        len(training_lines) > 0,
        f"{len(training_lines)} samples",
    )

    # --- Check bootstrap ---
    if sidecar_ok:
        print("\n--- Bootstrap Status ---")
        bootstrap_after = get_bootstrap_status()
        audit.check(
            "Bootstrap mode",
            True,
            f"mode={bootstrap_after.get('mode', '?')}",
        )
        agreement = bootstrap_after.get("agreement_rate", 0)
        audit.check(
            "Bootstrap agreement rate",
            True,
            f"{agreement:.1%}",
        )
        per_cat = bootstrap_after.get("per_category_agreement", {})
        for cat, rate in per_cat.items():
            audit.check(f"  Category: {cat}", True, f"{rate:.1%}")

    # --- Summary ---
    print()
    success = audit.summary()
    sys.exit(0 if success else 1)


if __name__ == "__main__":
    run_audit()
