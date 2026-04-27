import json
import sys
import traceback


def to_int(v, default):
    try:
        return int(v)
    except (TypeError, ValueError):
        return default


def run(inputs, params, letters, env):
    lst = inputs.get("list")
    if lst is None:
        lst = (letters or {}).get("a", [])
    if not isinstance(lst, list):
        try:
            lst = list(lst)
        except TypeError:
            lst = []
    mode = str(params.get("mode") or "first")
    n = to_int(params.get("n"), 10)
    start = to_int(params.get("start"), 0)
    end_raw = params.get("end")
    end = to_int(end_raw, len(lst)) if end_raw not in (None, "") else len(lst)
    if mode == "first":
        return {"list": lst[:n]}
    if mode == "last":
        if n <= 0:
            return {"list": []}
        return {"list": lst[-n:]}
    return {"list": lst[start:end]}


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
