import json
import sys
import traceback


OPS = {
    "lower": str.lower,
    "upper": str.upper,
    "title": str.title,
    "trim": str.strip,
    "reverse": lambda s: s[::-1],
    "swapcase": str.swapcase,
    "capitalize": str.capitalize,
}


def run(inputs, params, letters, env):
    text = inputs.get("text")
    if text is None:
        text = (letters or {}).get("a", "")
    op = OPS.get(str(params.get("op") or "lower"), str.lower)
    return {"text": op(str(text))}


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
