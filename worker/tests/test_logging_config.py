"""#29 stage 1: the worker's logs must be parseable JSON and must carry the
correlation fields consumer.py passes.

Both assertions below fail against the format string this replaced
(`'{"level": "%(levelname)s", "msg": %(message)r}'` in __main__.py) - that
is the point of the file. To see it, stash this branch and run:

    logging.basicConfig(format='{"level": "%(levelname)s", "msg": %(message)r}')
    logging.getLogger("t").info("nacking for redelivery", extra={"org_id": "o1"})
    -> {"level": "INFO", "msg": 'nacking for redelivery'}

which `json.loads` rejects at the single quote, and which contains no
`org_id` at all.
"""

import json
import logging
from io import StringIO

import pytest

from frontdesk_worker.logging_config import JsonFormatter, configure_logging


def _emit(
    msg: str,
    *,
    level: int = logging.INFO,
    extra: dict[str, object] | None = None,
    exc: BaseException | None = None,
) -> dict[str, object]:
    """Logs one record through JsonFormatter and returns the parsed object."""
    stream = StringIO()
    handler = logging.StreamHandler(stream)
    handler.setFormatter(JsonFormatter())
    logger = logging.getLogger(f"test.{msg[:12]}.{level}")
    logger.handlers = [handler]
    logger.setLevel(logging.DEBUG)
    logger.propagate = False

    if exc is not None:
        try:
            raise exc
        except type(exc):
            logger.exception(msg, extra=extra or {})
    else:
        logger.log(level, msg, extra=extra or {})

    lines = stream.getvalue().strip().split("\n")
    assert len(lines) == 1, f"expected exactly one line, got {lines!r}"
    parsed = json.loads(lines[0])
    assert isinstance(parsed, dict)
    return parsed


# The exact strings consumer.py logs. Parametrised rather than asserted once
# because the old format's failure was *message-dependent*: repr() switches
# to double quotes when the message contains an apostrophe, so a single
# happily-chosen test message would have passed against the broken format.
@pytest.mark.parametrize(
    "message",
    [
        "message processing failed - nacking for redelivery",
        "message exceeded the retry ceiling - dead-lettering",
        "message failed contract validation - dead-lettering, not retrying",
        "worker started",
        "it's a message with an apostrophe",
        'a message with "double quotes"',
        "a message with a \\ backslash and a \n newline",
        "unicode: café — naïve",
    ],
)
def test_every_line_is_parseable_json(message: str) -> None:
    parsed = _emit(message)
    assert parsed["msg"] == message
    assert parsed["level"] == "INFO"


def test_extra_fields_reach_the_log_line() -> None:
    """The defect that mattered operationally: consumer.py passes these on
    every one of its six log calls and the old format referenced none of
    them."""
    parsed = _emit(
        "message processing failed - nacking for redelivery",
        level=logging.ERROR,
        extra={
            "msg_id": "42",
            "org_id": "11111111-1111-1111-1111-111111111111",
            "request_id": "22222222-2222-2222-2222-222222222222",
            "delivery_attempt": 3,
        },
    )
    assert parsed["org_id"] == "11111111-1111-1111-1111-111111111111"
    assert parsed["request_id"] == "22222222-2222-2222-2222-222222222222"
    assert parsed["msg_id"] == "42"
    # An int stays an int - not str()'d into "3", so a log pipeline can
    # range-query it.
    assert parsed["delivery_attempt"] == 3
    assert parsed["level"] == "ERROR"


def test_owned_fields_are_present_and_ordered_first() -> None:
    parsed = _emit("worker started")
    assert list(parsed)[:4] == ["level", "msg", "time", "logger"]
    logger_name = parsed["logger"]
    assert isinstance(logger_name, str)
    assert logger_name.startswith("test.")


def test_time_is_utc_iso8601_with_milliseconds() -> None:
    import datetime

    parsed = _emit("worker started")
    time = parsed["time"]
    assert isinstance(time, str)
    assert time.endswith("Z"), time
    # Parses as a real timestamp (the same shape db/src/logger.ts emits via
    # toISOString) rather than merely looking like one. fromisoformat accepts
    # the "Z" suffix directly on 3.11+; the endswith assertion above is what
    # pins the suffix itself.
    dt = datetime.datetime.fromisoformat(time)
    assert dt.tzinfo is not None
    assert dt.utcoffset() == datetime.timedelta(0)
    # "....sss" - milliseconds, three digits.
    assert len(time.split(".")[1]) == 4, time


def test_lazy_percent_formatting_still_works() -> None:
    stream = StringIO()
    handler = logging.StreamHandler(stream)
    handler.setFormatter(JsonFormatter())
    logger = logging.getLogger("test.lazy")
    logger.handlers = [handler]
    logger.setLevel(logging.DEBUG)
    logger.propagate = False

    logger.info("enqueued %d documents for org %s", 7, "acme")

    parsed = json.loads(stream.getvalue().strip())
    assert parsed["msg"] == "enqueued 7 documents for org acme"


def test_exception_traceback_is_carried_in_one_field() -> None:
    """consumer.py reports failures with logger.exception(); the traceback is
    the whole value of that call, and it must not break the JSON."""
    parsed = _emit(
        "message processing failed - nacking for redelivery",
        extra={"org_id": "o1"},
        exc=RuntimeError("provider returned 503"),
    )
    exc = parsed["exc"]
    assert isinstance(exc, str)
    assert "RuntimeError" in exc
    assert "provider returned 503" in exc
    # Still one line, still parseable - asserted by _emit itself. The
    # traceback's own newlines live inside the JSON string.
    assert parsed["org_id"] == "o1"


def test_reserved_record_attributes_are_not_leaked() -> None:
    """Only caller context belongs in the object. A hardcoded reserved-name
    list written against an older Python would leak whatever the stdlib
    added since (3.12's `taskName` being the live example)."""
    parsed = _emit("worker started")
    for leaked in ("args", "levelno", "pathname", "lineno", "taskName", "msecs", "relativeCreated"):
        assert leaked not in parsed, f"{leaked} leaked into the log line"


def test_unserialisable_extra_value_does_not_crash_the_log_call() -> None:
    """A log call is not worth taking a consumer loop down for."""

    class Opaque:
        def __str__(self) -> str:
            return "opaque-value"

    parsed = _emit("worker started", extra={"thing": Opaque()})
    assert parsed["thing"] == "opaque-value"


def test_configure_logging_replaces_handlers_rather_than_accumulating() -> None:
    """basicConfig no-ops when root already has a handler, which would leave
    a plain-text handler in place; a second configure_logging() call must not
    double every line either."""
    root = logging.getLogger()
    original = root.handlers[:]
    original_level = root.level
    try:
        stream_one = StringIO()
        configure_logging(stream=stream_one)
        configure_logging(stream=stream_one)
        assert len(root.handlers) == 1

        logging.getLogger("test.configure").info("worker started", extra={"org_id": "o1"})
        lines = stream_one.getvalue().strip().split("\n")
        assert len(lines) == 1
        assert json.loads(lines[0])["org_id"] == "o1"
    finally:
        for handler in root.handlers[:]:
            root.removeHandler(handler)
        for handler in original:
            root.addHandler(handler)
        root.setLevel(original_level)
