"""Structured JSON logging for the worker (#29 stage 1, ADR-0038 §2).

Replaces the `logging.basicConfig(format='{"level": ..., "msg": %(message)r}')`
one-liner that `__main__.py` used to carry. That format string had two
defects, both proven before this module was written (see
tests/test_logging_config.py, which fails against the old format):

1. **It did not emit valid JSON.** `%(message)r` is Python's `repr()`, which
   quotes with single quotes: a log line read
   `{"level": "INFO", "msg": 'message processing failed - nacking'}`.
   `json.loads` rejects that at the `'`. It happened to parse only for
   messages containing an apostrophe, where `repr()` switches to double
   quotes - so "the logs are JSON" was true for the rarest case and false
   for every ordinary one. A log pipeline that parses JSON (#29 stage 3's
   Loki, ADR-0026's deferred trigger) would have dropped essentially every
   line the worker ever wrote.
2. **It discarded every correlation field.** The format string references
   only `levelname` and `message`, so the `extra={"org_id": ..., "request_id":
   ..., "msg_id": ..., "delivery_attempt": ...}` that consumer.py has always
   passed on all six of its log calls went nowhere. `docs/conventions.md`
   requires "structured JSON logs everywhere with `org_id` and `request_id`
   when available"; for the worker that was false on both halves.

The formatter takes whatever a caller passes in `extra=` and merges it into
the object, rather than naming fields explicitly, because the alternative is
a format string that has to be edited every time a call site adds context -
which is how defect 2 happened.

No OpenTelemetry SDK here, and no dependency added: ADR-0038 §2 keeps stage 1
to the correlation fields the queue contract already carries. `trace_id`/
`span_id` are stage 2's, and when they arrive they arrive as two more keys in
this same object.
"""

import datetime
import json
import logging
from typing import TextIO

# Derived from a throwaway record rather than hardcoded: a record's __dict__
# is exactly the set of attributes the logging module puts there, so this
# tracks the stdlib across versions (`taskName` is 3.12+, and a hardcoded
# list written on 3.11 would have leaked it into every log line as if it
# were caller context). `message` and `asctime` are added by Formatter
# itself, after the record is constructed, so they are not in that dict.
_RESERVED_RECORD_ATTRS = frozenset(vars(logging.LogRecord("", 0, "", 0, "", None, None))) | {
    "message",
    "asctime",
}


class JsonFormatter(logging.Formatter):
    """One JSON object per line: level, msg, time, logger, then any
    `extra=` fields the call site passed, then the exception if there is one.

    `msg` is the *formatted* message (`record.getMessage()`), so `%s`-style
    lazy formatting still works. Key order is fixed for the fields this
    formatter owns so a human tailing the log reads the same shape every
    line; `extra` keys follow in insertion order.
    """

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, object] = {
            "level": record.levelname,
            "msg": record.getMessage(),
            # UTC with an explicit offset, matching db/src/logger.ts's
            # `new Date().toISOString()` so both languages' lines sort and
            # parse identically in one stream.
            "time": self.formatTime(record, "%Y-%m-%dT%H:%M:%S.%03dZ"),
            "logger": record.name,
        }

        for key, value in record.__dict__.items():
            if key in _RESERVED_RECORD_ATTRS or key.startswith("_"):
                continue
            # A field whose value is not JSON-serialisable must not take the
            # whole line down - a log call is not worth crashing a consumer
            # loop over. str() it and keep going.
            try:
                json.dumps(value)
            except (TypeError, ValueError):
                value = str(value)
            payload[key] = value

        if record.exc_info:
            # logger.exception() is how consumer.py reports a failed
            # message; the traceback is the whole value of that call.
            payload["exc"] = self.formatException(record.exc_info)
        if record.stack_info:
            payload["stack"] = self.formatStack(record.stack_info)

        # ensure_ascii=True (the default): the output is read by line-based
        # tooling, and an escaped non-ASCII character is unambiguous where a
        # raw one depends on the reader's encoding.
        return json.dumps(payload)

    def formatTime(self, record: logging.LogRecord, datefmt: str | None = None) -> str:
        # Formatter.formatTime's %-substitution goes through time.strftime,
        # which has no milliseconds directive - the base class's own
        # `default_msec_format` handles that, and only when datefmt is None.
        # Build the timestamp directly instead so it always carries ms.
        del datefmt
        return (
            datetime.datetime.fromtimestamp(record.created, tz=datetime.UTC)
            .isoformat(timespec="milliseconds")
            .replace("+00:00", "Z")
        )


def configure_logging(level: int = logging.INFO, *, stream: TextIO | None = None) -> None:
    """Installs JsonFormatter as the root handler's formatter.

    Idempotent and destructive in the same way `basicConfig` is not: it
    *replaces* root's handlers rather than no-op'ing when one already exists
    (basicConfig's behaviour, which silently leaves a pre-existing plain-text
    handler in place). A second call in the same process - a test, an
    entrypoint imported twice - must not produce two lines per log call.
    """
    handler = logging.StreamHandler(stream) if stream is not None else logging.StreamHandler()
    handler.setFormatter(JsonFormatter())

    root = logging.getLogger()
    for existing in root.handlers[:]:
        root.removeHandler(existing)
    root.addHandler(handler)
    root.setLevel(level)
