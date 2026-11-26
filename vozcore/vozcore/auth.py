"""Cookie-session authentication — verifies the same `vp_at` JWT the Node API
issues (HS256, `type: access`), so one login session works across both
services without any shared cookie rewriting."""

from __future__ import annotations

import uuid

import jwt as pyjwt
from fastapi import Request

from .config import settings
from .errors import EngineAuthError

ACCESS_COOKIE = "vp_at"


def current_user_id(request: Request) -> str:
    token = request.cookies.get(ACCESS_COOKIE)
    if not token:
        raise EngineAuthError("Authentication required.")
    try:
        payload = pyjwt.decode(token, settings.jwt_secret, algorithms=["HS256"])
    except pyjwt.PyJWTError:
        raise EngineAuthError("Session expired. Please sign in again.")
    if payload.get("type") != "access" or not payload.get("sub"):
        raise EngineAuthError("Session expired. Please sign in again.")
    user_id = str(payload["sub"])
    try:
        uuid.UUID(user_id)
    except ValueError:
        raise EngineAuthError("Session expired. Please sign in again.")
    return user_id


def sign_access_token(user_id: str, secret: str | None = None, ttl_seconds: int = 900) -> str:
    """Used by tests (and only by trusted server-side code) to mint sessions."""
    return pyjwt.encode(
        {"sub": user_id, "type": "access", "exp": __import__("time").time() + ttl_seconds},
        secret or settings.jwt_secret,
        algorithm="HS256",
    )
