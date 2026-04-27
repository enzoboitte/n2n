"""Stub Python — ce module est géré par le runtime côté renderer.
Si Python est appelé directement, on renvoie le timestamp courant.
"""

import json
import sys
import time


if __name__ == "__main__":
    sys.stdout.write(
        json.dumps({"epoch_ms": int(time.time() * 1000), "iso": ""})
    )
