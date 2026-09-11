import pytest

from frontdesk_worker.contracts import (
    InvalidIngestMessage,
    InvalidTriageMessage,
    validate_ingest_message,
    validate_triage_message,
)


def test_accepts_a_complete_message() -> None:
    body = {"orgId": "org-1", "requestId": "req-1"}
    assert validate_triage_message(body) == body


@pytest.mark.parametrize(
    "body",
    [
        {"requestId": "req-1"},
        {"orgId": "", "requestId": "req-1"},
        {"orgId": "org-1"},
        {"orgId": "org-1", "requestId": ""},
        {"orgId": "org-1", "requestId": "req-1", "extra": "nope"},
        None,
        "not an object",
        42,
    ],
)
def test_rejects_invalid_messages(body: object) -> None:
    with pytest.raises(InvalidTriageMessage):
        validate_triage_message(body)


def test_accepts_a_complete_ingest_message() -> None:
    body = {"orgId": "org-1", "documentId": "doc-1"}
    assert validate_ingest_message(body) == body


@pytest.mark.parametrize(
    "body",
    [
        {"documentId": "doc-1"},
        {"orgId": "", "documentId": "doc-1"},
        {"orgId": "org-1"},
        {"orgId": "org-1", "documentId": ""},
        {"orgId": "org-1", "documentId": "doc-1", "extra": "nope"},
        None,
        "not an object",
        42,
    ],
)
def test_rejects_invalid_ingest_messages(body: object) -> None:
    with pytest.raises(InvalidIngestMessage):
        validate_ingest_message(body)
