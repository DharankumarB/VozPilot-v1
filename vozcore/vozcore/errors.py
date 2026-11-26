"""Typed engine errors mapped to the VozPilot JSON error envelope."""

from __future__ import annotations

from typing import Any


class VozCoreError(Exception):
    status = 500
    code = "vozcore_error"

    def __init__(self, message: str, details: Any = None):
        super().__init__(message)
        self.message = message
        self.details = details


class EngineAuthError(VozCoreError):
    status = 401
    code = "unauthenticated"


class NotFoundError(VozCoreError):
    status = 404
    code = "not_found"


class CommandValidationError(VozCoreError):
    status = 422
    code = "validation_error"


class ConfigUnavailableError(VozCoreError):
    """No OpenAI credentials — a clear configuration message, never fake results."""

    status = 503
    code = "vozcore_not_configured"


class LLMCallError(VozCoreError):
    status = 502
    code = "llm_error"


class ConflictError(VozCoreError):
    status = 409
    code = "conflict"
