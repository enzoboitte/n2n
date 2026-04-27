import datetime as dt
import json
import sys
import time
import traceback


def run(inputs, params, letters, env):
    fmt = str(params.get("format") or "%Y-%m-%d %H:%M:%S")
    tz = str(params.get("tz") or "local").lower()
    now = dt.datetime.now(dt.timezone.utc) if tz == "utc" else dt.datetime.now()
    epoch_s = time.time()
    return {
        "iso": now.isoformat(),
        "epoch": epoch_s,
        "epoch_ms": int(epoch_s * 1000),
        "formatted": now.strftime(fmt),
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
