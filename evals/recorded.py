"""Replay/record LLM provider for the eval gate (ADR-0036).

CI never spends a token: `RecordedProvider` answers every `complete()` call
from `evals/fixtures/completions.json`, keyed on a SHA-256 of the rendered
messages. A prompt that was never recorded is a hard failure
(`UnrecordedPrompt`), never a silent skip - a prompt edit changes the hash,
which forces a deliberate `run.py --record` and a reviewable fixture diff.

`RecordingProvider` wraps a real provider (whatever `llm.get_provider`
returns for the operator's `LLM_PROVIDER`) and writes what it saw. It is
human-run only; `run.py` refuses `--record` without real credentials.

Both implement `llm.LLMProvider` (ADR-0006). Neither names a provider.
"""

import hashlib
import json
from pathlib import Path
from typing import Any

from llm import Completion, LLMProvider, Message

REPLAY_PROVIDER_NAME = "recorded"


class UnrecordedPrompt(Exception):
    """The rendered prompt has no fixture. Re-record with
    `evals/run.py --record` (human-run, costs real tokens)."""


def prompt_key(messages: list[Message], *, max_tokens: int, temperature: float) -> str:
    """Stable hash of everything that shapes the completion. Sampling
    parameters are part of the key so a `temperature` change cannot replay
    a completion recorded under different settings."""
    payload = {
        "messages": [{"role": m.role, "content": m.content} for m in messages],
        "max_tokens": max_tokens,
        "temperature": temperature,
    }
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _subject_line(messages: list[Message]) -> str:
    """A human-readable label for the fixture diff: the request subject the
    classify prompt embeds. Falls back to the first 80 characters."""
    last_user = next((m.content for m in reversed(messages) if m.role == "user"), "")
    for line in last_user.splitlines():
        if line.startswith("Subject:"):
            return line.removeprefix("Subject:").strip()
    return last_user[:80]


def load_fixtures(path: Path) -> dict[str, dict[str, Any]]:
    if not path.exists():
        return {}
    data = json.loads(path.read_text())
    if not isinstance(data, dict):
        raise TypeError(f"{path}: expected a JSON object keyed by prompt hash")
    return data


def save_fixtures(path: Path, fixtures: dict[str, dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(fixtures, indent=2, sort_keys=True) + "\n")


class RecordedProvider:
    """Replay-only. Zero network, zero cost, deterministic."""

    def __init__(self, fixtures_path: Path) -> None:
        self._path = fixtures_path
        self._fixtures = load_fixtures(fixtures_path)

    @property
    def size(self) -> int:
        return len(self._fixtures)

    async def complete(
        self,
        messages: list[Message],
        *,
        tools: list[dict[str, Any]] | None = None,
        max_tokens: int,
        temperature: float,
    ) -> Completion:
        key = prompt_key(messages, max_tokens=max_tokens, temperature=temperature)
        entry = self._fixtures.get(key)
        if entry is None:
            raise UnrecordedPrompt(
                f"no recorded completion for prompt {key[:12]}... "
                f"(subject: {_subject_line(messages)!r}) in {self._path}. "
                "The prompt or its inputs changed; run `evals/run.py --record` and commit "
                "the fixture diff."
            )
        return Completion(
            text=entry["text"],
            input_tokens=int(entry["input_tokens"]),
            output_tokens=int(entry["output_tokens"]),
            finish_reason=entry.get("finish_reason", "stop"),
            cost_usd=0.0,
            provider=REPLAY_PROVIDER_NAME,
            model=entry["model"],
        )


class RecordingProvider:
    """Wraps a real provider and captures every completion into the fixture
    map. `flush()` writes the file; `cost_usd` totals what the run spent."""

    def __init__(self, inner: LLMProvider, fixtures_path: Path) -> None:
        self._inner = inner
        self._path = fixtures_path
        self._fixtures: dict[str, dict[str, Any]] = {}
        self.cost_usd = 0.0
        self.calls = 0

    async def complete(
        self,
        messages: list[Message],
        *,
        tools: list[dict[str, Any]] | None = None,
        max_tokens: int,
        temperature: float,
    ) -> Completion:
        completion = await self._inner.complete(
            messages, tools=tools, max_tokens=max_tokens, temperature=temperature
        )
        key = prompt_key(messages, max_tokens=max_tokens, temperature=temperature)
        self._fixtures[key] = {
            "subject": _subject_line(messages),
            "model": completion.model,
            "text": completion.text,
            "input_tokens": completion.input_tokens,
            "output_tokens": completion.output_tokens,
            "finish_reason": completion.finish_reason,
        }
        self.cost_usd += completion.cost_usd
        self.calls += 1
        return completion

    def flush(self) -> None:
        # Rewrite, don't merge: a stale entry for a prompt that no longer
        # exists would never be exercised and would hide from review.
        save_fixtures(self._path, self._fixtures)
