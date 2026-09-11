# ADR-0024: The provider-isolation grep test bans LLM provider names in application code, not the AWS SDK and not test files

Status: decided 2026-09-11

Amends ADR-0006's "Switch-proof" clause. ADR-0006's decision text is unchanged;
this ADR narrows the scope of one mechanism it describes.

## Context

ADR-0006 says:

> A grep-based test asserts no file outside `worker/llm/` references
> `openrouter`, `bedrock`, or `boto3`.

That sentence was written on 2026-09-07, when `worker/` was an empty directory
and the only imagined use of `boto3` was the Bedrock adapter. Implementing #23
made two problems with it concrete, neither of which is a disagreement with what
ADR-0006 was protecting:

**1. `boto3` is also ADR-0004's SQS SDK.** ADR-0004 requires a `SqsQueue`
adapter as the second `Queue` implementation, and in Python that is `boto3` —
the same import string, for an unrelated service, in
`worker/frontdesk_worker/queue/sqs.py`. Taken literally the two decided ADRs
cannot both be satisfied: ADR-0004 requires the import, ADR-0006 bans the
string. The TypeScript side never hit this because `api/`'s SQS adapter imports
`@aws-sdk/client-sqs`, a different string from anything ADR-0006 names, so the
collision existed only in the Python half and only once it was written.

**2. Tests that exercise a provider adapter must name it.**
`test_llm_openrouter.py` cannot record a respx fixture for OpenRouter without
the word `openrouter`; `test_provider_parity.py` compares all three adapters by
construction. A grep that included test files would make ADR-0006's own
switch-proof unimplementable.

The leak ADR-0006 actually guards against is application code *outside the
adapter package* branching on, or reaching for, a specific LLM provider — the
thing that would make `LLM_PROVIDER=bedrock` insufficient to switch providers.
Neither a queue adapter using the AWS SDK nor a test fixture naming the provider
it tests is that leak.

## Decision

The provider-isolation test (`worker/tests/test_provider_isolation.py`) asserts:

- **Strings banned:** `openrouter`, `bedrock`. **Not `boto3`**, which ADR-0004
  independently requires for the SQS adapter and which says nothing about which
  LLM provider is live.
- **Scope:** `worker/frontdesk_worker/` — the runtime application package.
  Not `worker/llm/` (the adapters, which must name providers), not
  `worker/tests/` (which must name providers to test them), not documentation.

The equivalent constraint on the TypeScript side is unchanged and is enforced by
convention rather than a test: `api/src/queue/sqs.ts` is the only production file
that may import `@aws-sdk/*`, as its header comment states.

**What still fails the test, correctly:** any module under
`worker/frontdesk_worker/` that imports an LLM adapter directly, names a provider
in a conditional, or reads a provider-specific API key. `settings.py` already
demonstrates the required discipline — it validates `LLM_PROVIDER` by importing
`llm.KNOWN_PROVIDERS` rather than writing the provider names itself, and never
reads a provider's API key (`llm.get_provider()` does that).

## Consequences

- ADR-0006 keeps its decision text and gains a status-line pointer here.
- The AWS SDK's presence in the worker is now governed by ADR-0004 alone, where
  it belongs. The `Queue` interface, not a grep, is what keeps SQS swappable.
- The switch-proof ADR-0006 actually cares about is unweakened: `provider-parity`
  still asserts identical normalized `Completion` output across all three
  adapters, and `LLM_PROVIDER` is still the only selector.
- If the worker ever grows a second use of `boto3` that *is* LLM-related outside
  `worker/llm/`, that is a real violation this test no longer catches. The
  defence is `provider-parity` plus review, which is where it was already.

## Rejected

- **Keep the literal rule and move the SQS `boto3` usage inside `worker/llm/`.**
  The review agent offered this as an alternative. It would put a queue adapter
  in the LLM package to satisfy a grep — inverting ADR-0004's and ADR-0006's
  boundaries to preserve a string match. The directory structure should follow
  the architecture, not the test.
- **Keep the literal rule and allow-list `queue/sqs.py`.** An allow-list entry
  is a permanent hole in the test aimed at one file, and the next reader cannot
  tell whether it was reasoned or expedient. Narrowing the rule to what it means
  is honest and re-reviewable.
- **Include `worker/tests/` in the grep with per-file exemptions.** Every adapter
  test would need an exemption, which is the rule not applying rather than the
  rule with exceptions.
- **Say nothing and leave the clarification in the test's docstring**, which is
  what the first attempt on PR #99 did (at Hermes's instruction — the brief said
  "add one sentence to ADR-0006", which is editing decided text in place). The
  review agent blocked it, correctly: a rule that lives in two places drifts, and
  the enforcing test is the worst place to record why the rule is narrower than
  the ADR says.
