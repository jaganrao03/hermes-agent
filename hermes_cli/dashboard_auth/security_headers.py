"""Baseline hardening headers for the login page and ``/api/*`` responses.

Deliberately no ``Content-Security-Policy``: ``/login`` ships inline style and
script, and the SPA document already gets its CSP from ``webapp_page_policy``.
"""

from __future__ import annotations

from starlette.requests import Request

HARDENING_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
}


def wants_hardening_headers(path: str) -> bool:
    """True for ``/login`` (also behind a proxy prefix) and every ``/api/`` route."""
    return path.startswith("/api/") or path.rstrip("/").rsplit("/", 1)[-1] == "login"


async def hardening_headers_middleware(request: Request, call_next):
    response = await call_next(request)
    if wants_hardening_headers(request.url.path):
        for name, value in HARDENING_HEADERS.items():
            response.headers.setdefault(name, value)
    return response
