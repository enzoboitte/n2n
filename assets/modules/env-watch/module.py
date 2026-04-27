"""Observer env — émet la valeur courante d'une variable d'environnement."""

import json
import sys
import traceback


def run(inputs: dict, params: dict, letters: dict, env: dict) -> dict:
    var = str(params.get("var") or "")
    return {"value": (env or {}).get(var)}


if __name__ == "__main__":
    payload = json.loads(sys.stdin.read() or "{}")
    try:
        result = run(
            payload.get("inputs") or {},
            payload.get("params") or {},
            payload.get("letters") or {},
            payload.get("env") or {},
        )
        sys.stdout.write(json.dumps(result, default=str))
    except Exception:
        sys.stderr.write(traceback.format_exc())
        sys.exit(1)
