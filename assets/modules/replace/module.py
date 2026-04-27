import json
import sys
import traceback


def run(inputs, params, letters, env):
    text = inputs.get("text")
    if text is None:
        text = (letters or {}).get("a", "")
    find = str(params.get("find") or "")
    repl = str(params.get("replace") or "")
    if not find:
        return {"text": str(text)}
    return {"text": str(text).replace(find, repl)}


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
