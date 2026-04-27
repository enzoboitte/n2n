import json
import sys
import time
import traceback


def run(inputs, params, letters, env):
    try:
        ms = int(params.get("ms") or 0)
    except (TypeError, ValueError):
        ms = 0
    if ms > 0:
        time.sleep(ms / 1000.0)
    value = inputs.get("value")
    if value is None:
        value = (letters or {}).get("a")
    return {"value": value}


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
