CONTAINER ?= docker
COMPOSE ?= $(CONTAINER) compose

POSTGRES_USER ?= frontdesk
POSTGRES_DB ?= frontdesk

.PHONY: help up down logs psql lint typecheck test eval bootstrap

.DEFAULT_GOAL := help

help:
	@echo "Targets:"
	@echo "  up         start postgres (pgvector+pgmq) and localstack"
	@echo "  down       stop and remove local services"
	@echo "  logs       follow logs for local services"
	@echo "  psql       open a psql shell against the local postgres"
	@echo "  lint       eslint/prettier (pnpm) + ruff (uv)"
	@echo "  typecheck  tsc (pnpm) + pyright (uv)"
	@echo "  test       vitest (pnpm) + pytest (uv)"
	@echo "  eval       evals/run.py against evals/golden, compared to baseline.json"
	@echo "  bootstrap  install ingress-nginx/cert-manager/sealed-secrets/observability (#16)"
	@echo ""
	@echo "Use CONTAINER=podman to run against Podman instead of Docker."

up:
	$(COMPOSE) up -d --wait

down:
	$(COMPOSE) down

logs:
	$(COMPOSE) logs -f

psql:
	$(COMPOSE) exec postgres psql -U $(POSTGRES_USER) -d $(POSTGRES_DB)

lint:
	pnpm lint
	cd worker && uv run ruff check .

typecheck:
	pnpm typecheck
	cd worker && uv run pyright

test:
	pnpm test
	cd worker && uv run pytest

eval:
	@echo "not implemented until #30"

bootstrap:
	KUBECONFIG=infra/hetzner/kubeconfig ./deploy/bootstrap/bootstrap.sh
