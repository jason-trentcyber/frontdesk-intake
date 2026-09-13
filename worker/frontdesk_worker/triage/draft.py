"""F7: draft generation with mandatory chunk citations.

The reply text itself is the draft body - no JSON wrapper - with citations
inline as `[c:<chunk id>]`. A citation naming an id that was not retrieved
is rejected: the draft is regenerated once with a corrective reminder
listing only the valid ids, and if that still fails validation the caller
escalates to needs_human (pipeline.py) rather than accepting an ungrounded
citation - an id retrieval never returned could be fabricated, or simply
unverifiable, and either way is not the same guarantee as a citation this
pipeline can point back to a real, retrieved chunk.

Token counts are accumulated and returned even when validation ultimately
fails: both attempts are real spend against the org's daily budget
(spend.py sums drafts.tokens_in/out as the only record of usage), so a
failed draft must not make its cost invisible to that accounting.
"""

import logging
import re
from dataclasses import dataclass

from llm import LLMProvider, Message

from .prompts import DRAFT_TEMPLATE
from .retrieve import RetrievedChunk

logger = logging.getLogger(__name__)

_CITATION_RE = re.compile(r"\[c:([^\]]+)\]")
_MAX_TOKENS = 600
_MAX_ATTEMPTS = 2


@dataclass(frozen=True)
class DraftResult:
    text: str
    cited_ids: list[str]
    model: str


@dataclass(frozen=True)
class DraftOutcome:
    # None means citation validation failed on every attempt - the caller
    # escalates to needs_human. input_tokens/output_tokens are the sum
    # across every attempt regardless.
    result: DraftResult | None
    input_tokens: int
    output_tokens: int


def _render_chunks(chunks: list[RetrievedChunk]) -> str:
    return "\n\n".join(f"[c:{chunk.id}] {chunk.text}" for chunk in chunks)


def _extract_citations(text: str) -> list[str]:
    seen: list[str] = []
    for match in _CITATION_RE.findall(text):
        if match not in seen:
            seen.append(match)
    return seen


async def generate_draft(
    provider: LLMProvider, subject: str, body: str, chunks: list[RetrievedChunk]
) -> DraftOutcome:
    valid_ids = {chunk.id for chunk in chunks}
    chunks_block = _render_chunks(chunks)

    total_input_tokens = 0
    total_output_tokens = 0
    reminder = ""
    for attempt in range(1, _MAX_ATTEMPTS + 1):
        prompt = DRAFT_TEMPLATE.format(subject=subject, body=body, chunks=chunks_block) + reminder
        completion = await provider.complete(
            [Message(role="user", content=prompt)], max_tokens=_MAX_TOKENS, temperature=0.2
        )
        total_input_tokens += completion.input_tokens
        total_output_tokens += completion.output_tokens

        cited_ids = _extract_citations(completion.text)
        invalid = [cid for cid in cited_ids if cid not in valid_ids]
        if not invalid:
            return DraftOutcome(
                result=DraftResult(
                    text=completion.text, cited_ids=cited_ids, model=completion.model
                ),
                input_tokens=total_input_tokens,
                output_tokens=total_output_tokens,
            )

        final_attempt = attempt == _MAX_ATTEMPTS
        logger.warning(
            "draft cited an unretrieved chunk id after retry - escalating to needs_human"
            if final_attempt
            else "draft cited an unretrieved chunk id - retrying",
            extra={"attempt": attempt, "invalid_citation_count": len(invalid)},
        )
        reminder = (
            "\n\nYour previous reply cited a source id that was not provided. "
            f"Only cite these ids: {', '.join(sorted(valid_ids))}."
        )

    return DraftOutcome(
        result=None, input_tokens=total_input_tokens, output_tokens=total_output_tokens
    )
