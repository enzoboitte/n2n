import json
import sys
import traceback


def to_int(v, default):
    try:
        return int(v)
    except (TypeError, ValueError):
        return default


def run(inputs, params, letters, env):
    start = to_int(params.get("start"), 0)
    end = to_int(params.get("end"), 10)
    step = to_int(params.get("step"), 1) or 1
    return {"list": list(range(start, end, step))}


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
