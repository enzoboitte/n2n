import json
import sys
import traceback


def run(inputs, params, letters, env):
    label = str(params.get("label") or "log")
    value = inputs.get("value")
    if value is None:
        value = (letters or {}).get("a")
    sys.stderr.write(f"[{label}] {json.dumps(value, default=str, ensure_ascii=False)}\n")
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
