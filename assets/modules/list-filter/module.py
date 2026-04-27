import json
import sys
import traceback


def run(inputs, params, letters, env):
    lst = inputs.get("list")
    if lst is None:
        lst = (letters or {}).get("a", [])
    if not isinstance(lst, list):
        try:
            lst = list(lst)
        except TypeError:
            lst = []
    expr = str(params.get("expression") or "True")
    out = []
    for item in lst:
        ns = {
            "item": item,
            "len": len,
            "str": str,
            "int": int,
            "float": float,
            "bool": bool,
            **(env or {}),
        }
        try:
            if eval(expr, {"__builtins__": {}}, ns):
                out.append(item)
        except Exception:
            continue
    return {"list": out}


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
