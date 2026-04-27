import json
import sys
import traceback


def run(inputs, params, letters, env):
    lst = inputs.get("list")
    if lst is None:
        lst = (letters or {}).get("a", [])
    sep = str(params.get("separator") or "")
    if not isinstance(lst, list):
        try:
            lst = list(lst)
        except TypeError:
            lst = [lst]
    return {"text": sep.join("" if v is None else str(v) for v in lst)}


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
