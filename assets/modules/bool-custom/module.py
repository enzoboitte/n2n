"""Booléen personnalisé — évalue une expression Python sur les entrées.

Variables disponibles dans l'expression :
    a, b, c, …  : valeurs des arêtes entrantes (ordre d'arrivée)
    NOM_VAR     : variables d'environnement globales
    len, str, int, float, bool : helpers Python autorisés

La sortie active relaie le DICT complet des lettres ({a: …, b: …, c: …}),
ce qui permet à un nœud `picker` en aval d'extraire la valeur de son choix.
La sortie inactive vaut None (branche non prise).
"""

import json
import sys
import traceback


def run(inputs: dict, params: dict, letters: dict, env: dict) -> dict:
    expr = str(params.get("expression") or "False")
    table = dict(letters or {})
    namespace = {
        "len": len,
        "str": str,
        "int": int,
        "float": float,
        "bool": bool,
        **(env or {}),
        **table,  # letters override env on conflict
    }
    matches = bool(eval(expr, {"__builtins__": {}}, namespace))
    return {
        "true": table if matches else None,
        "false": None if matches else table,
    }


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
