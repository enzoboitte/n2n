"""Module Majuscules — transforme le texte d'entrée.

Contrat n2n :
    stdin  : JSON {"inputs": {"text": "..."}, "params": {}}
    stdout : JSON {"text": "..."}
"""

import json
import sys


def run(inputs: dict, params: dict) -> dict:
    text = inputs.get("text", "")
    return {"text": str(text).upper()}


if __name__ == "__main__":
    raw = sys.stdin.read() or "{}"
    payload = json.loads(raw)
    try:
        result = run(payload.get("inputs") or {}, payload.get("params") or {})
        sys.stdout.write(json.dumps(result))
    except Exception as exc:  # noqa: BLE001
        sys.stderr.write(f"{type(exc).__name__}: {exc}")
        sys.exit(1)
