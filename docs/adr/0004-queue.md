# ADR-0004: pgmq in production, SQS adapter tested against LocalStack

Status: decided 2026-09-07; extended by ADR-0025, which adds a second queue
(`frontdesk_ingest`) and its own message contract. The interface, the two
adapters and the pgmq/LocalStack split below are unchanged.

## Context
No AWS account in v1. A mock (LocalStack) in production would undercut the credibility the project exists to establish.

## Decision
- `Queue` interface in `api/` (producer) and `worker/` (consumer): `send`, `receive(visibility_timeout)`, `ack`, `nack`, `dead_letter`.
- `PostgresQueue` on the pgmq extension is the production adapter on Hetzner. Zero extra containers.
- `SqsQueue` on boto3 / AWS SDK v3 is the second adapter. CI runs the same contract tests against pgmq (Postgres service container) and SQS (LocalStack service container).
- Selection by `QUEUE_PROVIDER` env only.
- SNS is not needed: one producer, one consumer group. If fan-out arrives, add an `Events` interface then.

## Rejected
- NATS JetStream: good tech, unfamiliar to the audience, one more container on an 8 GB node.
- LocalStack in production: it is a mock.
- Live SQS from Hetzner: requires the AWS account we are deferring.
