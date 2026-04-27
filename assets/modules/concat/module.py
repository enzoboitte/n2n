import json
import sys
import traceback


def run(inputs, params, letters, env):
    sep = str(params.get("separator") or "")
    parts = ["" if v is None else str(v) for v in (letters or {}).values()]
    return {"value": sep.join(parts)}


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
