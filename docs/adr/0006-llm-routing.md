# ADR-0006: OpenRouter is the live provider; the Bedrock adapter is switch-proven

Status: decided 2026-09-07; the grep test's scope (which files, which
strings) is clarified and narrowed by ADR-0024. The decision below is
unchanged.

## Context
Jason wants a real production LLM with defensible configuration, without opening an AWS account in v1. The Bedrock path must be demonstrably a configuration change, not a promise.

## Decision
- `LLMProvider` interface in `worker/llm/`: `complete(messages, tools?, max_tokens, temperature) -> Completion{text, input_tokens, output_tokens, finish_reason, cost_usd, provider, model}`.
- Adapters: `OpenRouterProvider` (live in dev, CI, prod), `BedrockProvider` (boto3 `bedrock-runtime` Converse API), `FakeProvider` (deterministic, for unit tests and the eval harness's cached mode).
- Selection by `LLM_PROVIDER` env only. Model ids per provider come from `worker/llm/models.yaml`, so `LLM_MODEL=haiku` resolves to `anthropic/claude-haiku-4.5` on OpenRouter and `anthropic.claude-haiku-4-5-*` on Bedrock.
- Production model: Claude Haiku 4.5 via OpenRouter. Spend cap $10/month on the key. Per-org daily token budget enforced in the worker.
- Cost table lives in the README (Bedrock, OpenRouter, Hetzner GPU, Ollama) with the break-even math.

## Switch-proof (CI job `provider-parity`)
- Contract tests run against all three adapters with identical inputs. Bedrock uses botocore `Stubber` with recorded Converse responses; OpenRouter uses recorded HTTP fixtures (respx). Normalized `Completion` outputs must be equal.
- A grep-based test asserts no file outside `worker/llm/` references `openrouter`, `bedrock`, or `boto3`.
- README section "Switch to Bedrock" is five lines: set `LLM_PROVIDER=bedrock`, `AWS_REGION`, credentials via IRSA or env, redeploy.

## Rejected
- Ollama in prod on the app node: CPU inference starves Postgres and the app, 60 s replies. Kept as a documented adapter target, not shipped.
- Bedrock live now: requires the AWS account; deferred.
- Anthropic direct API: fine, but OpenRouter gives one key for many models and a dashboard spend cap.
