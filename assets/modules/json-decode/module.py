import json
import sys
import traceback


def run(inputs, params, letters, env):
    raw = inputs.get("text")
    if raw is None:
        raw = (letters or {}).get("a")
    if raw is None or raw == "":
        return {"value": None}
    try:
        return {"value": json.loads(raw)}
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
