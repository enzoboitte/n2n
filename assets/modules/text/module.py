"""Module Texte — émet une chaîne fixe en sortie.

Contrat n2n :
    stdin  : JSON {"inputs": {...}, "params": {...}}
    stdout : JSON {<output_name>: <value>, ...}
    stderr : message d'erreur (en cas d'exit code != 0)
"""

import json
import sys


def run(inputs: dict, params: dict) -> dict:
    # Couche libre — ce que l'utilisateur veut faire
    return {"text": params.get("value", "")}


if __name__ == "__main__":
    raw = sys.stdin.read() or "{}"
    payload = json.loads(raw)
    try:
        result = run(payload.get("inputs") or {}, payload.get("params") or {})
        sys.stdout.write(json.dumps(result))
    except Exception as exc:  # noqa: BLE001
        sys.stderr.write(f"{type(exc).__name__}: {exc}")
        sys.exit(1)
