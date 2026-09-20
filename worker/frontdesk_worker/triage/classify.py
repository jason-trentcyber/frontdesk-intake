"""F4 (classify) + F5 (route): one LLM call per request, parsed as JSON.

A response that fails to parse, or names a category/urgency the org did not
configure, is not retried - it degrades to a safe default. This is the path
LLM_PROVIDER=fake (the manual killswitch) and a global-spend-ceiling
downgrade to FakeProvider (ADR-0023 §5 layer 3) both take on every request,
and ADR-0023 §5 is explicit that the pipeline must keep running end to end
with deterministic output in that case, not crash. A real provider
occasionally returning malformed JSON gets the same graceful handling for
the same reason - it is a degraded classification, not a pipeline failure.

Never log the raw completion text or parsing exception text verbatim: both
are derived from the org's own request content (subject/body echoed back by
the model, or embedded in a JSON parse error's context snippet), and this
worker's logs are not a place tenant content belongs (same reasoning
consumer.py already applies to an unvalidated queue message body).
"""

import json
import logging
import re
from dataclasses import dataclass

from llm import LLMProvider, Message

from .prompts import CLASSIFY_TEMPLATE

logger = logging.getLogger(__name__)

DEFAULT_CATEGORY = "other"
DEFAULT_URGENCY = "normal"
DEFAULT_UNASSIGNED_LANE = "unassigned"
_VALID_URGENCIES = frozenset({"low", "normal", "high"})
_MAX_TOKENS = 200
# A Markdown code fence around the JSON object, with or without a language
# tag. The prompt says "no markdown code fences"; the configured model wraps
# every response in one anyway (#133, found by the eval gate's first
# --record run - all 20 of evals/fixtures/completions.json are fenced).
# Stripped before parsing; nothing else about the parse is loosened.
_FENCE_RE = re.compile(r"\A\s*```[a-zA-Z0-9_-]*\s*\n?(.*?)\n?\s*```\s*\Z", re.DOTALL)


@dataclass(frozen=True)
class Classification:
    category: str
    urgency: str
    summary: str
    lane: str
    model: str
    input_tokens: int
    output_tokens: int


async def classify_and_route(
    provider: LLMProvider,
    categories: list[str],
    lanes: dict[str, str],
    subject: str,
    body: str,
) -> Classification:
    prompt = CLASSIFY_TEMPLATE.format(
        categories=", ".join(categories) if categories else DEFAULT_CATEGORY,
        subject=subject,
        body=body,
    )
    completion = await provider.complete(
        [Message(role="user", content=prompt)], max_tokens=_MAX_TOKENS, temperature=0.0
    )
    category, urgency, summary = _parse(completion.text, categories)
    # F5: route via the org's own category -> lane map. A category the map
    # doesn't cover (should not happen - _parse already snaps to a
    # configured category, or DEFAULT_CATEGORY when the org has none) still
    # gets a lane rather than null, so routing never blocks on a
    # classification gap.
    lane = lanes.get(category) or next(iter(lanes.values()), DEFAULT_UNASSIGNED_LANE)
    return Classification(
        category=category,
        urgency=urgency,
        summary=summary,
        lane=lane,
        model=completion.model,
        input_tokens=completion.input_tokens,
        output_tokens=completion.output_tokens,
    )


def _strip_fence(text: str) -> str:
    match = _FENCE_RE.match(text)
    return match.group(1) if match else text


def _parse(text: str, categories: list[str]) -> tuple[str, str, str]:
    try:
        data = json.loads(_strip_fence(text))
        category = data["category"]
        urgency = data["urgency"]
        summary = data["summary"]
        if not isinstance(category, str) or (categories and category not in categories):
            raise ValueError("category not in the org's configured set")
        if urgency not in _VALID_URGENCIES:
            raise ValueError("urgency not one of low/normal/high")
        if not isinstance(summary, str) or not summary.strip():
            raise ValueError("summary missing or empty")
        return category, urgency, summary.strip()
    except (json.JSONDecodeError, KeyError, ValueError, TypeError) as exc:
        logger.warning(
            "classify response failed to parse - using safe defaults",
            extra={"error_type": type(exc).__name__},
        )
        fallback_category = (
            DEFAULT_CATEGORY
            if (not categories or DEFAULT_CATEGORY in categories)
            else categories[0]
        )
        return fallback_category, DEFAULT_URGENCY, "unable to classify automatically"
