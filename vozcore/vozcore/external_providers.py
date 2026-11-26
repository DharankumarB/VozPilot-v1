"""Real external service integrations for VozPilot Phase 3 agents.

- Web search & URL fetching for Research Agent (Tavily / Serper / Brave / Custom).
- Gmail REST API v1 (OAuth 2.0) for Inbox Agent.
- Google Calendar REST API v3 (OAuth 2.0) for Schedule Agent.
- GitHub REST API v3 (OAuth 2.0) for Developer Agent.

Strict honesty rules:
- Production code NEVER fabricates search results, emails, calendar events or
  repository files. Missing credentials / disconnected OAuth return explicit
  unconfigured / disconnected status objects.
- Retrieved external text is wrapped in `<untrusted_external_data>` fences via
  `security.wrap_untrusted_content`.
- Automated tests may inject in-process mock handlers via `set_test_mocks(...)`;
  production never sets them.
"""

from __future__ import annotations

import base64
import html
import logging
import re
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

import httpx

from . import db
from .config import settings
from .db import Utf8Json as JSON
from .security import (
    SecurityViolationError,
    decrypt_token,
    encrypt_token,
    redact_secrets,
    validate_outbound_url,
    wrap_untrusted_content,
)

logger = logging.getLogger("vozcore.external")

# Test-only provider mock registry (never set in production).
_test_mocks: dict[str, Callable[..., Any]] = {}


def set_test_mocks(mocks: dict[str, Callable[..., Any]] | None) -> None:
    global _test_mocks
    _test_mocks = dict(mocks) if mocks else {}


def clear_test_mocks() -> None:
    global _test_mocks
    _test_mocks = {}


def _strip_html(raw_html: str, max_chars: int = 10_000) -> str:
    text = re.sub(r"<(script|style|noscript)[^>]*>.*?</\1>", " ", raw_html, flags=re.I | re.S)
    text = re.sub(r"<[^>]+>", " ", text)
    text = html.unescape(text)
    text = re.sub(r"\s+", " ", text).strip()
    return text[:max_chars]


# ---------------------------------------------------------------------------
# OAuth Token Loader + Google Token Refresh (RLS-scoped)
# ---------------------------------------------------------------------------


def load_integration_credentials(conn, provider: str) -> dict[str, Any]:
    """Load an integration row inside the user's RLS transaction without leaking tokens."""
    row = db.row(
        conn,
        """
        SELECT provider, status, account_email, scopes, encrypted_access_token,
               encrypted_refresh_token, token_expires_at, provider_metadata
          FROM integrations
         WHERE provider = %s
        """,
        (provider,),
    )
    if not row or row["status"] != "connected" or not row.get("encrypted_access_token"):
        return {
            "connected": False,
            "provider": provider,
            "status": (row or {}).get("status", "not_connected"),
            "accountEmail": (row or {}).get("account_email"),
            "scopes": (row or {}).get("scopes") or [],
            "accessToken": None,
            "refreshToken": None,
            "expiresAt": None,
        }
    access_token = decrypt_token(row["encrypted_access_token"])
    refresh_token = decrypt_token(row.get("encrypted_refresh_token"))
    return {
        "connected": True,
        "provider": provider,
        "status": row["status"],
        "accountEmail": row.get("account_email"),
        "scopes": row.get("scopes") or [],
        "accessToken": access_token,
        "refreshToken": refresh_token,
        "expiresAt": row.get("token_expires_at"),
        "metadata": row.get("provider_metadata") or {},
    }


async def ensure_google_access_token(user_id: str, provider: str) -> dict[str, Any]:
    """Return a valid Google OAuth token (refreshing if expired & refresh token exists)."""
    import asyncio

    creds = await asyncio.to_thread(
        db.run_in_user_txn, user_id, lambda c: load_integration_credentials(c, provider)
    )
    if not creds["connected"] or not creds["accessToken"]:
        return creds

    expires_at = creds.get("expiresAt")
    now = datetime.now(timezone.utc)
    if isinstance(expires_at, datetime):
        exp_utc = expires_at if expires_at.tzinfo else expires_at.replace(tzinfo=timezone.utc)
        if exp_utc <= now + timedelta(seconds=60):
            if creds.get("refreshToken") and settings.google_client_id and settings.google_client_secret:
                async with httpx.AsyncClient(timeout=15.0) as client:
                    resp = await client.post(
                        "https://oauth2.googleapis.com/token",
                        data={
                            "client_id": settings.google_client_id,
                            "client_secret": settings.google_client_secret,
                            "refresh_token": creds["refreshToken"],
                            "grant_type": "refresh_token",
                        },
                    )
                    if resp.status_code == 200:
                        token_data = resp.json()
                        new_token = token_data.get("access_token")
                        expires_in = int(token_data.get("expires_in", 3600))
                        if new_token:
                            enc = encrypt_token(new_token)
                            new_exp = now + timedelta(seconds=expires_in)

                            def _save(conn):
                                db.execute(
                                    conn,
                                    """
                                    UPDATE integrations
                                       SET encrypted_access_token = %s, token_expires_at = %s
                                     WHERE provider = %s
                                    """,
                                    (enc, new_exp, provider),
                                )

                            await asyncio.to_thread(db.run_in_user_txn, user_id, _save)
                            creds["accessToken"] = new_token
                            creds["expiresAt"] = new_exp
    return creds


# ---------------------------------------------------------------------------
# 1. Research Agent — Web Search & Safe URL Fetch
# ---------------------------------------------------------------------------


async def web_search(query: str, max_results: int = 5) -> dict[str, Any]:
    """Search the web via the configured provider (Tavily / Serper / Brave / Custom)."""
    if "web_search" in _test_mocks:
        raw = _test_mocks["web_search"](query=query, max_results=max_results)
        return _normalize_search_results(query, raw.get("provider", "mock-search"), raw.get("results", []), configured=raw.get("configured", True), error=raw.get("error"))

    provider = (settings.search_provider or "").lower().strip()
    if not provider:
        if settings.tavily_api_key:
            provider = "tavily"
        elif settings.serper_api_key:
            provider = "serper"
        elif settings.brave_search_api_key:
            provider = "brave"
        elif settings.search_api_url:
            provider = "custom"

    if not provider:
        return {
            "configured": False,
            "provider": None,
            "query": query,
            "results": [],
            "message": (
                "No web search provider is configured on the server "
                "(set TAVILY_API_KEY, SERPER_API_KEY, BRAVE_SEARCH_API_KEY, or SEARCH_API_URL in .env). "
                "External claims that cannot be verified from provided context or workspace memory must be marked unverified."
            ),
        }

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            if provider == "tavily" and settings.tavily_api_key:
                resp = await client.post(
                    "https://api.tavily.com/search",
                    json={
                        "api_key": settings.tavily_api_key,
                        "query": query,
                        "max_results": max(1, min(max_results, 10)),
                        "include_answer": False,
                    },
                )
                resp.raise_for_status()
                body = resp.json()
                items = [
                    {
                        "title": r.get("title", ""),
                        "url": r.get("url", ""),
                        "snippet": r.get("content", ""),
                        "publishedAt": r.get("published_date"),
                    }
                    for r in body.get("results", [])
                    if r.get("url")
                ]
                return _normalize_search_results(query, "tavily", items)

            if provider == "serper" and settings.serper_api_key:
                resp = await client.post(
                    "https://google.serper.dev/search",
                    headers={"X-API-KEY": settings.serper_api_key, "Content-Type": "application/json"},
                    json={"q": query, "num": max(1, min(max_results, 10))},
                )
                resp.raise_for_status()
                body = resp.json()
                items = [
                    {
                        "title": r.get("title", ""),
                        "url": r.get("link", ""),
                        "snippet": r.get("snippet", ""),
                        "publishedAt": r.get("date"),
                    }
                    for r in body.get("organic", [])
                    if r.get("link")
                ]
                return _normalize_search_results(query, "serper", items)

            if provider == "brave" and settings.brave_search_api_key:
                resp = await client.get(
                    "https://api.search.brave.com/res/v1/web/search",
                    headers={"X-Subscription-Token": settings.brave_search_api_key, "Accept": "application/json"},
                    params={"q": query, "count": max(1, min(max_results, 10))},
                )
                resp.raise_for_status()
                body = resp.json()
                items = [
                    {
                        "title": r.get("title", ""),
                        "url": r.get("url", ""),
                        "snippet": r.get("description", ""),
                        "publishedAt": r.get("age"),
                    }
                    for r in (body.get("web") or {}).get("results", [])
                    if r.get("url")
                ]
                return _normalize_search_results(query, "brave", items)

            if provider == "custom" and settings.search_api_url:
                safe_url = validate_outbound_url(settings.search_api_url)
                resp = await client.get(safe_url, params={"q": query, "limit": max_results})
                resp.raise_for_status()
                body = resp.json()
                items = body.get("results", []) if isinstance(body, dict) else []
                return _normalize_search_results(query, "custom", items)

        return {
            "configured": False,
            "provider": provider,
            "query": query,
            "results": [],
            "message": f"Search provider '{provider}' selected, but its API key is missing in .env.",
        }
    except Exception as exc:
        return {
            "configured": True,
            "provider": provider,
            "query": query,
            "results": [],
            "error": redact_secrets(f"{type(exc).__name__}: {exc}"[:400]),
        }


def _normalize_search_results(
    query: str,
    provider: str | None,
    raw_items: list[dict[str, Any]],
    configured: bool = True,
    error: str | None = None,
) -> dict[str, Any]:
    sanitized_results = []
    injection_warnings: list[str] = []
    for item in raw_items:
        url = (item.get("url") or "").strip()
        if not url:
            continue
        wrapped = wrap_untrusted_content("web_search_snippet", url, item.get("snippet") or "", max_chars=1800)
        if wrapped["injectionDetected"]:
            injection_warnings.extend(str(x) for x in wrapped["injectionIndicators"])  # type: ignore[union-attr]
        sanitized_results.append(
            {
                "title": (item.get("title") or url)[:240],
                "url": url,
                "snippet": wrapped["sanitized"],
                "fencedSnippet": wrapped["fenced"],
                "publishedAt": item.get("publishedAt"),
                "injectionDetected": wrapped["injectionDetected"],
            }
        )
    return {
        "configured": configured,
        "provider": provider,
        "query": query,
        "results": sanitized_results,
        "injectionWarnings": injection_warnings,
        "error": error,
    }


async def fetch_public_webpage(url: str) -> dict[str, Any]:
    """Fetch and sanitize a public URL with SSRF protection."""
    safe_url = validate_outbound_url(url, resolve_dns=not bool(_test_mocks.get("fetch_url")))
    if "fetch_url" in _test_mocks:
        raw = _test_mocks["fetch_url"](url=safe_url)
        wrapped = wrap_untrusted_content("web_page", safe_url, raw.get("text", ""), max_chars=8000)
        return {
            "ok": raw.get("ok", True),
            "url": safe_url,
            "title": raw.get("title", safe_url),
            "fencedContent": wrapped["fenced"],
            "injectionDetected": wrapped["injectionDetected"],
            "error": raw.get("error"),
        }

    try:
        async with httpx.AsyncClient(timeout=12.0, follow_redirects=False) as client:
            resp = await client.get(safe_url, headers={"User-Agent": "VozPilot-ResearchAgent/3.0"})
            resp.raise_for_status()
            text = _strip_html(resp.text, max_chars=8000)
            wrapped = wrap_untrusted_content("web_page", safe_url, text, max_chars=8000)
            return {
                "ok": True,
                "url": safe_url,
                "statusCode": resp.status_code,
                "fencedContent": wrapped["fenced"],
                "injectionDetected": wrapped["injectionDetected"],
            }
    except SecurityViolationError:
        raise
    except Exception as exc:
        return {
            "ok": False,
            "url": safe_url,
            "fencedContent": "",
            "error": redact_secrets(f"{type(exc).__name__}: {exc}"[:300]),
        }


# ---------------------------------------------------------------------------
# 2. Inbox Agent — Gmail OAuth 2.0 Client (Read / Search / Send Approved Only)
# ---------------------------------------------------------------------------


def _decode_gmail_body(payload: dict[str, Any]) -> str:
    body_data = ((payload.get("body") or {}).get("data")) or ""
    if body_data:
        try:
            decoded = base64.urlsafe_b64decode(body_data + "===").decode("utf-8", errors="replace")
            return _strip_html(decoded, max_chars=4000)
        except Exception:
            pass
    for part in payload.get("parts") or []:
        mime = (part.get("mimeType") or "").lower()
        if mime == "text/plain":
            sub = _decode_gmail_body(part)
            if sub:
                return sub
    for part in payload.get("parts") or []:
        sub = _decode_gmail_body(part)
        if sub:
            return sub
    return ""


async def gmail_search_messages(user_id: str, query: str = "", max_results: int = 8) -> dict[str, Any]:
    """Read/search authorized Gmail messages; wrap every email as untrusted data."""
    if "gmail_search" in _test_mocks:
        raw = _test_mocks["gmail_search"](user_id=user_id, query=query, max_results=max_results)
        if not raw.get("connected", True):
            return raw
        messages = []
        for msg in raw.get("messages", []):
            wrapped = wrap_untrusted_content(
                "email",
                f"From: {msg.get('from', '')} | Subject: {msg.get('subject', '')}",
                f"Subject: {msg.get('subject', '')}\nFrom: {msg.get('from', '')}\n\n{msg.get('body', msg.get('snippet', ''))}",
                max_chars=4000,
            )
            messages.append(
                {
                    "id": msg.get("id"),
                    "threadId": msg.get("threadId"),
                    "from": msg.get("from", ""),
                    "subject": msg.get("subject", ""),
                    "date": msg.get("date", ""),
                    "labels": msg.get("labels", []),
                    "fencedBody": wrapped["fenced"],
                    "injectionDetected": wrapped["injectionDetected"],
                    "injectionIndicators": wrapped["injectionIndicators"],
                }
            )
        return {"connected": True, "accountEmail": raw.get("accountEmail"), "messages": messages}

    creds = await ensure_google_access_token(user_id, "gmail")
    if not creds["connected"] or not creds["accessToken"]:
        return {
            "connected": False,
            "messages": [],
            "message": (
                "Gmail OAuth is not connected for this workspace. Connect Gmail in Integrations "
                "to read or search live emails — Inbox Agent will work only from user-provided text."
            ),
        }

    headers = {"Authorization": f"Bearer {creds['accessToken']}"}
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            list_resp = await client.get(
                "https://gmail.googleapis.com/gmail/v1/users/me/messages",
                headers=headers,
                params={"q": query or "in:inbox", "maxResults": max(1, min(max_results, 15))},
            )
            list_resp.raise_for_status()
            refs = list_resp.json().get("messages") or []
            messages = []
            for ref in refs[:max_results]:
                msg_resp = await client.get(
                    f"https://gmail.googleapis.com/gmail/v1/users/me/messages/{ref['id']}",
                    headers=headers,
                    params={"format": "full"},
                )
                if msg_resp.status_code != 200:
                    continue
                detail = msg_resp.json()
                hdrs = {
                    h["name"].lower(): h["value"]
                    for h in ((detail.get("payload") or {}).get("headers") or [])
                    if "name" in h and "value" in h
                }
                body_text = _decode_gmail_body(detail.get("payload") or {}) or detail.get("snippet", "")
                wrapped = wrap_untrusted_content(
                    "email",
                    f"From: {hdrs.get('from', '')} | Subject: {hdrs.get('subject', '')}",
                    f"Subject: {hdrs.get('subject', '')}\nFrom: {hdrs.get('from', '')}\n\n{body_text}",
                    max_chars=4000,
                )
                messages.append(
                    {
                        "id": detail.get("id"),
                        "threadId": detail.get("threadId"),
                        "from": hdrs.get("from", ""),
                        "subject": hdrs.get("subject", ""),
                        "date": hdrs.get("date", ""),
                        "labels": detail.get("labelIds") or [],
                        "fencedBody": wrapped["fenced"],
                        "injectionDetected": wrapped["injectionDetected"],
                        "injectionIndicators": wrapped["injectionIndicators"],
                    }
                )
            return {"connected": True, "accountEmail": creds.get("accountEmail"), "messages": messages}
    except Exception as exc:
        return {
            "connected": True,
            "messages": [],
            "error": redact_secrets(f"Gmail API error: {type(exc).__name__}: {exc}"[:350]),
        }


# ---------------------------------------------------------------------------
# 3. Schedule Agent — Google Calendar OAuth 2.0 Client
# ---------------------------------------------------------------------------


async def calendar_list_events(
    user_id: str,
    time_min_iso: str,
    time_max_iso: str,
    timezone_name: str = "UTC",
) -> dict[str, Any]:
    """Read authorized Google Calendar events within [time_min_iso, time_max_iso]."""
    if "calendar_list" in _test_mocks:
        return _test_mocks["calendar_list"](
            user_id=user_id, time_min=time_min_iso, time_max=time_max_iso, timezone=timezone_name
        )

    creds = await ensure_google_access_token(user_id, "google_calendar")
    if not creds["connected"] or not creds["accessToken"]:
        return {
            "connected": False,
            "events": [],
            "message": (
                "Google Calendar OAuth is not connected for this workspace. Connect Google Calendar "
                "in Integrations to read live events — Schedule Agent will plan using workspace task "
                "deadlines and user-provided constraints."
            ),
        }

    headers = {"Authorization": f"Bearer {creds['accessToken']}"}
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(
                "https://www.googleapis.com/calendar/v3/calendars/primary/events",
                headers=headers,
                params={
                    "timeMin": time_min_iso,
                    "timeMax": time_max_iso,
                    "singleEvents": "true",
                    "orderBy": "startTime",
                    "timeZone": timezone_name,
                    "maxResults": 50,
                },
            )
            resp.raise_for_status()
            items = resp.json().get("items") or []
            events = []
            for ev in items:
                if ev.get("status") == "cancelled":
                    continue
                start = (ev.get("start") or {}).get("dateTime") or (ev.get("start") or {}).get("date")
                end = (ev.get("end") or {}).get("dateTime") or (ev.get("end") or {}).get("date")
                wrapped = wrap_untrusted_content(
                    "calendar_event",
                    ev.get("summary", "Event"),
                    ev.get("description") or "",
                    max_chars=1000,
                )
                events.append(
                    {
                        "id": ev.get("id"),
                        "summary": (ev.get("summary") or "(No title)")[:200],
                        "start": start,
                        "end": end,
                        "description": wrapped["sanitized"],
                        "attendees": len(ev.get("attendees") or []),
                    }
                )
            return {"connected": True, "accountEmail": creds.get("accountEmail"), "events": events}
    except Exception as exc:
        return {
            "connected": True,
            "events": [],
            "error": redact_secrets(f"Google Calendar API error: {type(exc).__name__}: {exc}"[:350]),
        }


# ---------------------------------------------------------------------------
# 4. Developer Agent — Authorized GitHub Repository Inspection (Read-Only)
# ---------------------------------------------------------------------------


async def github_inspect_repo(user_id: str, owner_repo: str, path: str = "") -> dict[str, Any]:
    """Inspect an authorized GitHub repository (read-only; writes require approval)."""
    if "github_inspect" in _test_mocks:
        return _test_mocks["github_inspect"](user_id=user_id, owner_repo=owner_repo, path=path)

    import asyncio

    creds = await asyncio.to_thread(
        db.run_in_user_txn, user_id, lambda c: load_integration_credentials(c, "github")
    )
    if not creds["connected"] or not creds["accessToken"]:
        return {
            "connected": False,
            "message": "GitHub OAuth is not connected for this workspace.",
        }

    if not re.match(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", owner_repo or ""):
        return {"connected": True, "error": "Repository must be in 'owner/repo' format."}

    headers = {
        "Authorization": f"Bearer {creds['accessToken']}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    clean_path = (path or "").strip("/")
    url = (
        f"https://api.github.com/repos/{owner_repo}/contents/{clean_path}"
        if clean_path
        else f"https://api.github.com/repos/{owner_repo}"
    )
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(url, headers=headers)
            resp.raise_for_status()
            data = resp.json()
            if isinstance(data, dict) and data.get("type") == "file" and data.get("content"):
                decoded = base64.b64decode(data["content"]).decode("utf-8", errors="replace")[:16_000]
                wrapped = wrap_untrusted_content("github_file", f"{owner_repo}/{clean_path}", decoded, max_chars=16_000)
                return {
                    "connected": True,
                    "repo": owner_repo,
                    "path": clean_path,
                    "type": "file",
                    "fencedContent": wrapped["fenced"],
                }
            return {"connected": True, "repo": owner_repo, "path": clean_path, "data": data}
    except Exception as exc:
        return {
            "connected": True,
            "repo": owner_repo,
            "error": redact_secrets(f"GitHub API error: {type(exc).__name__}: {exc}"[:350]),
        }
