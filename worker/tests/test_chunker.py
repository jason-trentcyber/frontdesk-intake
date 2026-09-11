import itertools

import pytest

from frontdesk_worker.ingestion.chunker import chunk_markdown
from frontdesk_worker.ingestion.embedder import ModelNotFetched, load_tokenizer

try:
    _tokenizer = load_tokenizer()
except ModelNotFetched:
    _tokenizer = None

requires_model = pytest.mark.skipif(
    _tokenizer is None,
    reason="worker/models/bge-small-en-v1.5/ not fetched - run `uv run python scripts/fetch_model.py`",
)


def _chunk(markdown: str, *, target_tokens: int = 400, overlap_tokens: int = 60) -> list[str]:
    # Narrows _tokenizer's type for every call site below in one place -
    # only ever called from a @requires_model test, where it is never None.
    assert _tokenizer is not None
    return chunk_markdown(
        markdown, _tokenizer, target_tokens=target_tokens, overlap_tokens=overlap_tokens
    )


@requires_model
def test_tiny_document_produces_exactly_one_chunk() -> None:
    chunks = _chunk("Hello there, this is a short note.")

    assert len(chunks) == 1
    assert chunks[0] == "Hello there, this is a short note."


@requires_model
def test_empty_document_produces_no_chunks() -> None:
    assert _chunk("") == []
    assert _chunk("   \n\n   ") == []


@requires_model
def test_heading_is_carried_as_a_prefix_on_every_chunk_under_it() -> None:
    markdown = "## Cleanings\n\nA routine cleaning is recommended every six months."

    [chunk] = _chunk(markdown)

    assert chunk.startswith("## Cleanings\n\n")
    assert "A routine cleaning" in chunk


@requires_model
def test_a_new_heading_replaces_the_prefix_for_content_under_it() -> None:
    # A small target forces the two sections apart into separate chunks -
    # each chunk's prefix must be the heading that actually governs its
    # own content, not whichever heading came first in the document.
    markdown = (
        "## Cleanings\n\nCleanings text here, padded out a little further.\n\n"
        "## Fillings\n\nFillings text here, also padded out a little further."
    )

    chunks = _chunk(markdown, target_tokens=12, overlap_tokens=0)

    assert len(chunks) == 2
    assert chunks[0].startswith("## Cleanings")
    assert chunks[1].startswith("## Fillings")
    assert "Fillings" not in chunks[0].split("\n\n", 1)[1]


@requires_model
def test_code_block_is_kept_intact_not_split_mid_line() -> None:
    code = "```python\ndef add(a, b):\n    return a + b\n```"
    markdown = f"## Example\n\n{code}"

    [chunk] = _chunk(markdown)

    assert code in chunk


@requires_model
def test_long_document_splits_into_multiple_chunks_with_overlap() -> None:
    # Each paragraph is short; many of them together comfortably exceed a
    # small target, forcing at least one split.
    paragraphs = [
        f"## Section {i}\n\nThis is paragraph number {i} with some content." for i in range(20)
    ]
    markdown = "\n\n".join(paragraphs)

    chunks = _chunk(markdown, target_tokens=50, overlap_tokens=10)

    assert len(chunks) > 1
    # Overlap: consecutive chunks share at least some text (the carried-
    # forward trailing block), so they are not a disjoint partition.
    for earlier, later in itertools.pairwise(chunks):
        earlier_tail = earlier.strip().splitlines()[-1]
        assert earlier_tail in later or later.split("\n\n")[0] in earlier


@requires_model
def test_oversized_code_block_splits_at_line_boundaries() -> None:
    lines = [f"line_{i} = {i}" for i in range(200)]
    code = "```python\n" + "\n".join(lines) + "\n```"

    chunks = _chunk(code, target_tokens=50, overlap_tokens=0)

    assert len(chunks) > 1
    # Every original line survives, whole, in exactly the pieces it was
    # split into - never truncated mid-line.
    rejoined = "\n".join(chunks)
    for line in lines:
        assert line in rejoined
