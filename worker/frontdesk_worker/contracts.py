"""Validates queue messages against docs/contracts/triage-message.schema.json (#23 §2).

The committed JSON file is generated from api/'s triageMessageSchema
(api/src/queue/index.ts, api/src/queue/contract.test.ts asserts no drift) -
this module validates against that file directly, never a hand-written
Python copy, so the two languages cannot silently diverge.

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
_CONTRACT_PATH = (
    Path(__file__).resolve().parents[2] / "docs" / "contracts" / "triage-message.schema.json"
)


class InvalidTriageMessage(Exception):
    """Raised when a queue message fails the committed contract schema."""


@lru_cache(maxsize=1)
def _schema() -> dict[str, Any]:
    return json.loads(_CONTRACT_PATH.read_text())


def validate_triage_message(body: Any) -> dict[str, Any]:
    """Validates `body` against the committed contract; returns it typed on success.

    Raises InvalidTriageMessage on failure. Callers must dead-letter on this
    exception rather than retry - a message that fails schema validation
    fails identically forever, and the queue has no RLS to catch what a
    malformed body might otherwise smuggle across tenants.
    """
    try:
        jsonschema.validate(body, _schema())
    except jsonschema.ValidationError as exc:
        raise InvalidTriageMessage(str(exc.message)) from exc
    return body
