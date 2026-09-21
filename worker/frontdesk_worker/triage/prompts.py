"""Loads the versioned prompt templates under worker/prompts/ (S7 -
REQUIREMENTS.md §5). A prompt change is editing one of those files, not a
string literal in this package - the file on disk *is* the prompt.

PROMPT_VERSION must match the newest entry in worker/prompts/CHANGELOG.md;
every draft this pipeline writes records it in drafts.prompt_version.
"""

from pathlib import Path

PROMPT_VERSION = "triage-v2"

# worker/frontdesk_worker/triage/prompts.py -> worker root is two parents
# up, same pattern as contracts.py's docs/contracts/ lookup.
_PROMPTS_DIR = Path(__file__).resolve().parents[2] / "prompts"


def _load(name: str) -> str:
    return (_PROMPTS_DIR / name).read_text()


CLASSIFY_TEMPLATE = _load("classify.md")
DRAFT_TEMPLATE = _load("draft.md")
