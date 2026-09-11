"""Validates queue messages against the committed contract files in
docs/contracts/ (ADR-0023 §2, ADR-0025 §1).

The committed JSON files are generated from api/'s triageMessageSchema and
ingestMessageSchema (api/src/queue/index.ts,
api/src/queue/triage-message-schema.test.ts and
api/src/queue/ingest-message-schema.test.ts assert no drift) - this module
validates against those files directly, never a hand-written Python copy,
so the two languages cannot silently diverge.

Validator: `jsonschema` - the obvious choice for validating against a
standard (2020-12) JSON Schema document without hand-rolling the checks
ourselves; no other candidate was considered necessary.
"""

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

import jsonschema

# worker/frontdesk_worker/contracts.py -> repo root is three parents up.
_CONTRACTS_DIR = Path(__file__).resolve().parents[2] / "docs" / "contracts"
_TRIAGE_CONTRACT_PATH = _CONTRACTS_DIR / "triage-message.schema.json"
_INGEST_CONTRACT_PATH = _CONTRACTS_DIR / "ingest-message.schema.json"


class InvalidTriageMessage(Exception):
    """Raised when a queue message fails the committed triage contract schema."""


class InvalidIngestMessage(Exception):
    """Raised when a queue message fails the committed ingest contract schema."""


@lru_cache(maxsize=1)
def _triage_schema() -> dict[str, Any]:
    return json.loads(_TRIAGE_CONTRACT_PATH.read_text())


@lru_cache(maxsize=1)
def _ingest_schema() -> dict[str, Any]:
    return json.loads(_INGEST_CONTRACT_PATH.read_text())


def validate_triage_message(body: Any) -> dict[str, Any]:
    """Validates `body` against the committed triage contract; returns it
    typed on success.

    Raises InvalidTriageMessage on failure. Callers must dead-letter on this
    exception rather than retry - a message that fails schema validation
    fails identically forever, and the queue has no RLS to catch what a
    malformed body might otherwise smuggle across tenants.
    """
    try:
        jsonschema.validate(body, _triage_schema())
    except jsonschema.ValidationError as exc:
        raise InvalidTriageMessage(str(exc.message)) from exc
    return body


def validate_ingest_message(body: Any) -> dict[str, Any]:
    """Same contract as validate_triage_message, against the ingest schema
    (ADR-0025 §1)."""
    try:
        jsonschema.validate(body, _ingest_schema())
    except jsonschema.ValidationError as exc:
        raise InvalidIngestMessage(str(exc.message)) from exc
    return body
