"""Écrire env — relaie la valeur en sortie et écrit dans l'env via la
convention `__env__`.

Tout module peut renvoyer une clé `__env__` dans ses outputs ; le runtime
n2n applique ces écritures sur l'env global puis retire la clé des outputs
visibles. Cela donne à n'importe quel module la capacité de définir/modifier
des variables d'env.
"""

import json
import sys
import traceback


def run(inputs: dict, params: dict, letters: dict, env: dict) -> dict:
    var = str(params.get("var") or "")
    value = (inputs or {}).get("value")
    if value is None:
        # Single visual input qui peut recevoir plusieurs arêtes — on prend la 1ʳᵉ
        value = (letters or {}).get("a")

    out = {"value": value}
    if var:
        out["__env__"] = {var: "" if value is None else str(value)}
    return out


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
