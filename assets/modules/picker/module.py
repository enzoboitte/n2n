"""Sélecteur — extrait la valeur de la lettre choisie.

Deux modes :
    1. L'amont est un dict (ex. sortie de bool-custom) → on pioche dedans.
    2. L'amont est une valeur simple → on utilise les lettres runtime
       (assignées par ordre d'arrivée des arêtes entrantes).
"""

import json
import sys
import traceback


def run(inputs: dict, params: dict, letters: dict) -> dict:
    letter = str(params.get("letter") or "a").strip().lower()
    upstream = (inputs or {}).get("value")
    if isinstance(upstream, dict):
        return {"value": upstream.get(letter)}
    return {"value": (letters or {}).get(letter)}


if __name__ == "__main__":
    payload = json.loads(sys.stdin.read() or "{}")
    try:
        result = run(
            payload.get("inputs") or {},
            payload.get("params") or {},
            payload.get("letters") or {},
        )
        sys.stdout.write(json.dumps(result, default=str))
    except Exception:
        sys.stderr.write(traceback.format_exc())
        sys.exit(1)
