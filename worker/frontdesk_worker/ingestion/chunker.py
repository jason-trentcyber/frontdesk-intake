"""Markdown-aware chunker (ADR-0005: "400-token target, 60-token overlap,
headings carried into each chunk as prefix").

Token counting: the real bge tokenizer (embedder.count_tokens), not a
word- or character-based approximation. The tokenizer is already on disk
(the same file the embedder loads) and tokenizing a short block is cheap,
so there is no real cost to using exact counts - and an approximation would
be systematically wrong here: WordPiece subword tokenization produces
noticeably more tokens than words for this kind of prose, so a word-count
heuristic would silently under-fill every chunk relative to the stated
400-token target. Precision costs nothing and the target means what it says.

Splitting unit: paragraphs, headings, and fenced code blocks, in that
priority - a fenced code block is never split mid-line unless it alone
exceeds the target (then it splits at line boundaries only, never mid-line).
A heading updates the "current heading" prefix; it is not a chunk of its
own. Overlap is carried forward at block granularity (whole trailing
paragraphs/code blocks from the previous chunk, not a token-level slice of
one) - slicing token ids and decoding them back to text is lossy for
whitespace and case, and blocks are the natural boundary this splitter
already produces.
"""

import re
from dataclasses import dataclass

from tokenizers import Tokenizer

from .embedder import count_tokens

DEFAULT_TARGET_TOKENS = 400
DEFAULT_OVERLAP_TOKENS = 60

_HEADING_RE = re.compile(r"^(#{1,6})\s+(.+)$")
_FENCE_RE = re.compile(r"^```")


@dataclass(frozen=True)
class _Block:
    kind: str  # "text" | "code"
    text: str
    heading: str | None


def _split_blocks(markdown: str) -> list[_Block]:
    lines = markdown.splitlines()
    blocks: list[_Block] = []
    current_heading: str | None = None
    buf: list[str] = []
    in_code = False
    code_buf: list[str] = []

    def flush_text() -> None:
        nonlocal buf
        if buf:
            text = "\n".join(buf).strip()
            if text:
                blocks.append(_Block("text", text, current_heading))
            buf = []

    for line in lines:
        if in_code:
            code_buf.append(line)
            if _FENCE_RE.match(line.strip()):
                blocks.append(_Block("code", "\n".join(code_buf), current_heading))
                code_buf = []
                in_code = False
            continue

        if _FENCE_RE.match(line.strip()):
            flush_text()
            in_code = True
            code_buf = [line]
            continue

        heading_match = _HEADING_RE.match(line)
        if heading_match:
            flush_text()
            current_heading = heading_match.group(0).strip()
            continue

        if line.strip() == "":
            flush_text()
            continue

        buf.append(line)

    flush_text()
    if in_code and code_buf:
        # Unterminated fence - emit what exists rather than drop it.
        blocks.append(_Block("code", "\n".join(code_buf), current_heading))

    return blocks


def _split_oversized_block(block: _Block, tokenizer: Tokenizer, target_tokens: int) -> list[_Block]:
    """A single block bigger than the whole target on its own. Code splits
    at line boundaries (never mid-line); text splits at word boundaries.
    """
    units = block.text.splitlines() if block.kind == "code" else block.text.split(" ")
    join = "\n" if block.kind == "code" else " "

    pieces: list[str] = []
    current: list[str] = []
    current_tokens = 0
    for unit in units:
        t = count_tokens(tokenizer, unit)
        if current and current_tokens + t > target_tokens:
            pieces.append(join.join(current))
            current = []
            current_tokens = 0
        current.append(unit)
        current_tokens += t
    if current:
        pieces.append(join.join(current))

    return [_Block(block.kind, p, block.heading) for p in pieces]


def _render(blocks: list[_Block]) -> str:
    heading = blocks[0].heading
    body = "\n\n".join(b.text for b in blocks)
    return f"{heading}\n\n{body}" if heading else body


def _overlap_tail(blocks: list[_Block], tokenizer: Tokenizer, overlap_tokens: int) -> list[_Block]:
    tail: list[_Block] = []
    acc = 0
    for block in reversed(blocks):
        if acc >= overlap_tokens:
            break
        tail.insert(0, block)
        acc += count_tokens(tokenizer, block.text)
    return tail


def chunk_markdown(
    markdown: str,
    tokenizer: Tokenizer,
    *,
    target_tokens: int = DEFAULT_TARGET_TOKENS,
    overlap_tokens: int = DEFAULT_OVERLAP_TOKENS,
) -> list[str]:
    """Splits `markdown` into chunk texts, each already carrying its
    governing heading as a prefix. A tiny document (below target_tokens
    entirely) returns exactly one chunk; an empty or whitespace-only
    document returns none.
    """
    blocks = _split_blocks(markdown)

    expanded: list[_Block] = []
    for block in blocks:
        if count_tokens(tokenizer, block.text) > target_tokens:
            expanded.extend(_split_oversized_block(block, tokenizer, target_tokens))
        else:
            expanded.append(block)

    chunks: list[str] = []
    current: list[_Block] = []
    current_tokens = 0

    for block in expanded:
        t = count_tokens(tokenizer, block.text)
        if current and current_tokens + t > target_tokens:
            chunks.append(_render(current))
            current = _overlap_tail(current, tokenizer, overlap_tokens)
            current_tokens = sum(count_tokens(tokenizer, b.text) for b in current)
        current.append(block)
        current_tokens += t

    if current:
        chunks.append(_render(current))

    return chunks
