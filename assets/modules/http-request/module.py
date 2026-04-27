"""Requête HTTP/HTTPS complète.

Fonctionnalités :
    - méthodes GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS
    - HTTPS avec option de désactivation de la vérification SSL
    - auth Bearer / Basic
    - query params, headers, body (JSON / form-encoded / texte)
    - redirections optionnelles
    - lecture par chunks (mémoire-friendly) avec taille max optionnelle
    - sortie binaire encodée base64 si non-utf8
    - sortie status + body + headers + flag ok (2xx)
"""

import base64
import json
import ssl
import sys
import traceback
import urllib.error
import urllib.parse
import urllib.request


CHUNK = 64 * 1024


def to_int(v, default):
    try:
        return int(v)
    except (TypeError, ValueError):
        return default


def to_float(v, default):
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def merge_query(url: str, query) -> str:
    if not query or not isinstance(query, dict):
        return url
    parsed = urllib.parse.urlparse(url)
    existing = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
    extras = [(str(k), str(v)) for k, v in query.items()]
    new_query = urllib.parse.urlencode(existing + extras, doseq=True)
    return urllib.parse.urlunparse(parsed._replace(query=new_query))


def encode_body(body, content_type: str):
    if body is None or body == "":
        return None
    if isinstance(body, (dict, list)):
        if content_type == "application/x-www-form-urlencoded":
            return urllib.parse.urlencode(body, doseq=True).encode("utf-8")
        return json.dumps(body).encode("utf-8")
    return str(body).encode("utf-8")


def build_opener(follow_redirects: bool, verify_ssl: bool):
    handlers = []
    if not follow_redirects:
        class _NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *_args, **_kwargs):
                return None
        handlers.append(_NoRedirect())
    if not verify_ssl:
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        handlers.append(urllib.request.HTTPSHandler(context=ctx))
    return urllib.request.build_opener(*handlers) if handlers else urllib.request.build_opener()


def read_capped(resp, max_bytes: int) -> bytes:
    out = []
    total = 0
    while True:
        chunk = resp.read(CHUNK)
        if not chunk:
            break
        if max_bytes and total + len(chunk) > max_bytes:
            out.append(chunk[: max_bytes - total])
            break
        out.append(chunk)
        total += len(chunk)
    return b"".join(out)


def decode_body(raw: bytes) -> str:
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return base64.b64encode(raw).decode("ascii")


def run(inputs, params, letters, env):
    method = str(params.get("method") or "GET").upper()
    url = str(params.get("url") or "").strip()
    query = params.get("query") or {}
    headers = {str(k): str(v) for k, v in (params.get("headers") or {}).items()}
    auth_type = str(params.get("auth_type") or "none").lower()
    auth_value = str(params.get("auth_value") or "")
    content_type = str(params.get("content_type") or "").strip()
    body = params.get("body") or ""
    timeout = to_float(params.get("timeout"), 30.0)
    follow_redirects = bool(params.get("follow_redirects", True))
    verify_ssl = bool(params.get("verify_ssl", True))
    max_bytes = to_int(params.get("max_response_bytes"), 0)

    if not url:
        return {"status": 0, "body": "URL manquante", "headers": {}, "ok": False}

    if auth_type == "bearer" and auth_value:
        headers.setdefault("Authorization", f"Bearer {auth_value}")
    elif auth_type == "basic" and auth_value:
        encoded = base64.b64encode(auth_value.encode()).decode()
        headers.setdefault("Authorization", f"Basic {encoded}")

    if content_type:
        headers.setdefault("Content-Type", content_type)

    full_url = merge_query(url, query)
    data = encode_body(body, content_type)
    req = urllib.request.Request(full_url, data=data, method=method, headers=headers)
    opener = build_opener(follow_redirects, verify_ssl)

    try:
        with opener.open(req, timeout=timeout) as resp:
            status = resp.status
            response_headers = {k: v for k, v in resp.headers.items()}
            raw = read_capped(resp, max_bytes)
            return {
                "status": status,
                "body": decode_body(raw),
                "headers": response_headers,
                "ok": 200 <= status < 300,
            }
    except urllib.error.HTTPError as exc:
        try:
            err_body = exc.read().decode("utf-8", errors="replace")
        except Exception:
            err_body = ""
        return {
            "status": exc.code,
            "body": err_body,
            "headers": {k: v for k, v in (exc.headers or {}).items()},
            "ok": False,
        }
    except urllib.error.URLError as exc:
        return {"status": 0, "body": f"URL error: {exc.reason}", "headers": {}, "ok": False}
    except Exception as exc:
        return {
            "status": 0,
            "body": f"{type(exc).__name__}: {exc}",
            "headers": {},
            "ok": False,
        }


if __name__ == "__main__":
    payload = json.loads(sys.stdin.read() or "{}")
    try:
        result = run(
            payload.get("inputs") or {},
            payload.get("params") or {},
            payload.get("letters") or {},
            payload.get("env") or {},
        )
        sys.stdout.write(json.dumps(result, default=str))
    except Exception:
        sys.stderr.write(traceback.format_exc())
        sys.exit(1)
