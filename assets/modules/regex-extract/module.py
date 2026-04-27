import json
import re
import sys
import traceback


def parse_flags(s):
    flags = 0
    s = (s or "").lower()
    if "i" in s:
        flags |= re.IGNORECASE
    if "s" in s:
        flags |= re.DOTALL
    if "m" in s:
        flags |= re.MULTILINE
    return flags


def run(inputs, params, letters, env):
    text = inputs.get("text")
    if text is None:
        text = (letters or {}).get("a", "")
    pattern = str(params.get("pattern") or "")
    if not pattern:
        return {"first": None, "all": [], "groups": None}
    flags = parse_flags(params.get("flags"))
    try:
        rx = re.compile(pattern, flags)
    except re.error as exc:
        return {"first": None, "all": [], "groups": None, "error": str(exc)}
    all_matches = rx.findall(str(text))
    first_match = rx.search(str(text))
    return {
        "first": first_match.group(0) if first_match else None,
        "all": all_matches,
        "groups": list(first_match.groups()) if first_match else None,
    }


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
