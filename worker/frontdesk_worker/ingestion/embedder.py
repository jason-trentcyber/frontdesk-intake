"""ONNX embedding of chunk text (ADR-0023 §3, ADR-0025 §4).

BAAI/bge-small-en-v1.5, pinned revision (worker/scripts/fetch_model.py),
384 dims. Pooling follows ADR-0023 §3: tokenize the input, run the ONNX
session, take the CLS token from the output, then L2-normalize it.
Verified against the official ONNX export's own input/output signature
(input_ids, attention_mask, token_type_ids -> last_hidden_state) rather
than guessed.

Batches are capped at MAX_BATCH_SIZE (ADR-0025 §4) - not a tuning knob, the
size ADR-0023's 377 MB peak-RSS measurement was taken at; the worker's
512Mi chart limit derives from that number. embed_batch() enforces the cap
itself so a caller bug shows up here, not as a surprise OOM.
"""

from pathlib import Path

import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer

MAX_BATCH_SIZE = 32
EMBEDDING_DIMENSIONS = 384
_MAX_SEQUENCE_LENGTH = 512

# worker/frontdesk_worker/ingestion/embedder.py -> worker root is two
# parents up, matching contracts.py's docs/contracts/ lookup pattern.
_MODEL_DIR = Path(__file__).resolve().parents[2] / "models" / "bge-small-en-v1.5"


class ModelNotFetched(Exception):
    """worker/models/bge-small-en-v1.5/ is missing. Run
    `uv run python scripts/fetch_model.py` from worker/ - see that script's
    docstring for why this is a separate, explicit step rather than an
    automatic download (ADR-0023 Consequences: no network at worker
    startup).
    """


def _resolve_model_dir(model_dir: Path | None) -> Path:
    directory = model_dir or _MODEL_DIR
    if not (directory / "tokenizer.json").exists():
        raise ModelNotFetched(f"{directory} is missing tokenizer.json")
    return directory


def load_tokenizer(model_dir: Path | None = None) -> Tokenizer:
    """The tokenizer alone, without the (much larger) ONNX session - the
    chunker (chunker.py) only needs this, to budget chunk boundaries
    against the exact tokenizer that will later encode them, without
    paying to load the embedding model itself.
    """
    directory = _resolve_model_dir(model_dir)
    tokenizer = Tokenizer.from_file(str(directory / "tokenizer.json"))
    tokenizer.enable_truncation(max_length=_MAX_SEQUENCE_LENGTH)
    return tokenizer


def count_tokens(tokenizer: Tokenizer, text: str) -> int:
    """Content-token count, no [CLS]/[SEP]: summing per-block counts that
    each included the two special tokens would inflate a multi-block
    chunk's budget by 2 tokens per block instead of 2 tokens total.
    """
    return len(tokenizer.encode(text, add_special_tokens=False).ids)


class Embedder:
    """Loads the ONNX session and tokenizer once; reused across every batch
    so the (single, ADR-0023 §4) worker process pays the load cost once,
    not per document.
    """

    def __init__(self, model_dir: Path | None = None) -> None:
        directory = _resolve_model_dir(model_dir)
        self.tokenizer = load_tokenizer(directory)
        self.tokenizer.enable_padding(pad_id=0, pad_token="[PAD]")
        self._session = ort.InferenceSession(
            str(directory / "model.onnx"), providers=["CPUExecutionProvider"]
        )

    def embed_batch(self, texts: list[str]) -> np.ndarray:
        if len(texts) > MAX_BATCH_SIZE:
            raise ValueError(f"embed_batch called with {len(texts)} texts, max is {MAX_BATCH_SIZE}")
        if not texts:
            return np.zeros((0, EMBEDDING_DIMENSIONS), dtype=np.float32)

        encodings = self.tokenizer.encode_batch(texts)
        input_ids = np.array([e.ids for e in encodings], dtype=np.int64)
        attention_mask = np.array([e.attention_mask for e in encodings], dtype=np.int64)
        token_type_ids = np.zeros_like(input_ids)

        outputs = self._session.run(
            None,
            {
                "input_ids": input_ids,
                "attention_mask": attention_mask,
                "token_type_ids": token_type_ids,
            },
        )
        # session.run()'s return type includes SparseTensor for the general
        # case; this model's single output is always a dense ndarray.
        last_hidden_state: np.ndarray = np.asarray(outputs[0])
        cls = last_hidden_state[:, 0, :]
        norms = np.linalg.norm(cls, axis=1, keepdims=True)
        return (cls / norms).astype(np.float32)
