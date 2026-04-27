import json
import math as _math
import sys
import traceback


def to_num(v):
    if isinstance(v, (int, float)):
        return v
    try:
        return float(v)
    except (TypeError, ValueError):
        return v


def run(inputs, params, letters, env):
    expr = str(params.get("expression") or "0")
    namespace = {
        "abs": abs,
        "min": min,
        "max": max,
        "round": round,
        "int": int,
        "float": float,
        "len": len,
        "math": _math,
    }
    for k, v in (env or {}).items():
        namespace[k] = to_num(v)
    for k, v in (letters or {}).items():
        namespace[k] = to_num(v)
    try:
        return {"value": eval(expr, {"__builtins__": {}}, namespace)}
    except Exception as exc:
        return {"value": None, "error": f"{type(exc).__name__}: {exc}"}


if __name__ == "__main__":
    payload = json.loads(sys.stdin.read() or "{}")
    try:
        sys.stdout.write(
            json.dumps(
                run(
                    payload.get("inputs") or {},
                    payload.get("params") or {},
                    payload.get("letters") or {},
                    payload.get("env") or {},
                ),
                default=str,
            )
        )
    except Exception:
        sys.stderr.write(traceback.format_exc())
        sys.exit(1)
