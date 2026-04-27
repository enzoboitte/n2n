import json
import sys
import traceback


def run(inputs, params, letters, env):
    text = inputs.get("text")
    if text is None:
        text = (letters or {}).get("a", "")
    sep = str(params.get("separator") or ",")
    trim = bool(params.get("trim", True))
    parts = str(text).split(sep)
    if trim:
        parts = [p.strip() for p in parts]
    return {"list": parts}


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
