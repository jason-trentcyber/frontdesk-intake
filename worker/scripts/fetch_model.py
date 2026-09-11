"""Downloads the pinned bge-small-en-v1.5 ONNX export into worker/models/.

ADR-0023's Consequences: "the worker image must ship the ONNX model file
rather than downloading it at startup: a cold start that reaches out to the
HF Hub is a startup dependency on a third party, and the probe run above
emitted an unauthenticated-rate-limit warning from that API. Bake the model
into the image, pinned by revision."

Pinned by REVISION (a commit sha), not `main` - a rebuild months from now
must fetch the exact same weights, not whatever the repo's default branch
points to by then. huggingface_hub is a build-time tool only: it is a
dependency of this script and of worker/Dockerfile's builder stage, never
imported by frontdesk_worker/ or llm/ at runtime (grep for it - it is not
there). Run this explicitly:

- worker/Dockerfile's builder stage runs it during the image build (network
  access at build time is normal and expected - pnpm/uv installs need it
  too; only the RUNNING container must not reach the network).
- CI's `python` job runs it before `pytest`, with the download cached by
  MODEL_REVISION so most runs don't re-fetch ~130 MB.
- Local dev: `uv run python scripts/fetch_model.py` once; tests that need
  the model skip with a clear reason if it isn't there yet (same pattern as
  `requires_postgres` in tests/conftest.py).
"""

from pathlib import Path

from huggingface_hub import hf_hub_download

MODEL_REPO = "BAAI/bge-small-en-v1.5"
# The commit this was pinned against when ADR-0023/ADR-0025 were written -
# bump deliberately, never let this drift to "main".
MODEL_REVISION = "5c38ec7c405ec4b44b94cc5a9bb96e735b38267a"
MODEL_FILES = (
    "onnx/model.onnx",
    "config.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "special_tokens_map.json",
    "vocab.txt",
)


def fetch(dest: Path | None = None) -> Path:
    target_dir = dest or (Path(__file__).resolve().parents[1] / "models" / "bge-small-en-v1.5")
    target_dir.mkdir(parents=True, exist_ok=True)
    for filename in MODEL_FILES:
        downloaded = hf_hub_download(repo_id=MODEL_REPO, filename=filename, revision=MODEL_REVISION)
        target = target_dir / Path(filename).name
        target.write_bytes(Path(downloaded).read_bytes())
    return target_dir


if __name__ == "__main__":
    path = fetch()
    print(f"fetched {MODEL_REPO}@{MODEL_REVISION} -> {path}")
