import numpy as np
import pytest

from frontdesk_worker.ingestion.embedder import (
    EMBEDDING_DIMENSIONS,
    MAX_BATCH_SIZE,
    Embedder,
    ModelNotFetched,
)

try:
    _embedder = Embedder()
except ModelNotFetched:
    _embedder = None

requires_model = pytest.mark.skipif(
    _embedder is None,
    reason="worker/models/bge-small-en-v1.5/ not fetched - run `uv run python scripts/fetch_model.py`",
)


@requires_model
def test_embed_batch_returns_l2_normalized_vectors_of_the_right_shape() -> None:
    assert _embedder is not None
    vectors = _embedder.embed_batch(["hello world", "a second sentence"])

    assert vectors.shape == (2, EMBEDDING_DIMENSIONS)
    norms = np.linalg.norm(vectors, axis=1)
    np.testing.assert_allclose(norms, 1.0, atol=1e-5)


@requires_model
def test_embed_batch_is_deterministic() -> None:
    assert _embedder is not None
    first = _embedder.embed_batch(["the quick brown fox"])
    second = _embedder.embed_batch(["the quick brown fox"])

    np.testing.assert_array_equal(first, second)


@requires_model
def test_embed_batch_empty_list_returns_empty_array() -> None:
    assert _embedder is not None
    vectors = _embedder.embed_batch([])

    assert vectors.shape == (0, EMBEDDING_DIMENSIONS)


@requires_model
def test_embed_batch_rejects_more_than_the_max_batch_size() -> None:
    assert _embedder is not None
    with pytest.raises(ValueError, match=str(MAX_BATCH_SIZE)):
        _embedder.embed_batch(["x"] * (MAX_BATCH_SIZE + 1))


@requires_model
def test_similar_sentences_are_closer_than_dissimilar_ones() -> None:
    assert _embedder is not None
    vectors = _embedder.embed_batch(
        [
            "A routine cleaning is recommended every six months.",
            "Cleanings should happen twice a year for most patients.",
            "The invoice is due on the fifteenth of next month.",
        ]
    )
    similar = float(np.dot(vectors[0], vectors[1]))
    dissimilar = float(np.dot(vectors[0], vectors[2]))

    assert similar > dissimilar
