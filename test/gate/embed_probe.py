"""
Empirical confirmation of the latent-confabulation root cause.

Hypothesis: the persistence of confabulation after the prefix fix is caused by
STALE un-prefixed stored patterns. A new `search_query:`-prefixed input still
scores >0.80 cosine against an OLD un-prefixed stored pattern, so nonsense keeps
matching. Once patterns are re-embedded as `search_document:`, nonsense should
separate (drop below threshold) while a genuine match stays high.

Tests both regimes against the REAL local Ollama (nomic-embed-text).
"""
import json
import math
import urllib.request

OLLAMA = "http://localhost:11434/api/embed"
MODEL = "nomic-embed-text"


def embed(text):
    data = json.dumps({"model": MODEL, "input": text}).encode()
    req = urllib.request.Request(
        OLLAMA, data=data, headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())["embeddings"][0]


def cos(a, b):
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(x * x for x in b))
    return dot / (na * nb) if na and nb else 0.0


queries = {
    "recall(name)": "what is my name",
    "nonsense": "how many glorps fit in a standard zanfibble",
}
# Stand-ins for stored patterns (the text that created the pattern embedding).
docs = {
    "pat:favorite color": "what is your favorite color",
    "pat:how are you": "how are you feeling today",
    "pat:name (TRUE match)": "what is my name",
    "pat:weather": "what is the weather like",
}

qP = {k: embed("search_query: " + v) for k, v in queries.items()}
dRaw = {k: embed(v) for k, v in docs.items()}                     # OLD un-prefixed
dDoc = {k: embed("search_document: " + v) for k, v in docs.items()}  # re-embedded

THRESH = 0.80
for qk, qv in qP.items():
    print(f"\n=== QUERY [{qk}]  (search_query:) ===")
    print("  vs OLD un-prefixed patterns (current contaminated hot layer):")
    for dk in docs:
        c = cos(qv, dRaw[dk])
        print(f"    {c:.3f} {'>=thr MATCH' if c >= THRESH else '         '}  {dk}")
    print("  vs re-embedded (search_document:) patterns (post cold-start):")
    for dk in docs:
        c = cos(qv, dDoc[dk])
        print(f"    {c:.3f} {'>=thr MATCH' if c >= THRESH else '         '}  {dk}")
