# =============================================================================
# MORPH
# =============================================================================
# Every target here is a thin wrapper. The logic lives in `scripts/` and in the
# package scripts, because the operator develops on Windows where `make` is not
# present - a Makefile that owns real logic would mean two implementations of the
# same workflow, and one of them would rot.
#
# On a machine without `make`, use the pnpm script named in each recipe.
# =============================================================================

COMPOSE := docker compose -f infra/docker-compose.yml
PNPM    := pnpm

.DEFAULT_GOAL := help
.PHONY: help bootstrap up down restart logs ps clean nuke dev build test verify \
        typecheck lint format migrate seed sim report shell-db shell-ch load-test

help: ## Show this help
	@echo ""
	@echo "MORPH - available targets"
	@echo ""
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[1m%-14s\033[0m %s\n", $$1, $$2}'
	@echo ""

# --- lifecycle ---------------------------------------------------------------

bootstrap: ## Bring the whole stack up with seeded data (pnpm bootstrap)
	@$(PNPM) bootstrap

up: ## Start every service
	@$(COMPOSE) up -d --wait

down: ## Stop every service, keeping data volumes
	@$(COMPOSE) down

restart: ## Restart the application services only
	@$(COMPOSE) restart web api worker admin

logs: ## Follow logs (make logs SERVICE=api)
	@$(COMPOSE) logs -f --tail=200 $(SERVICE)

ps: ## Show service status
	@$(COMPOSE) ps

clean: ## Remove build output and caches, keeping data
	@rm -rf .turbo coverage **/dist **/.next **/.turbo

nuke: ## Remove containers AND data volumes. Destructive and irreversible.
	@echo "This deletes every local database, event and queue. Type the project name to confirm:"
	@read -r confirm; [ "$$confirm" = "morph" ] || { echo "Aborted."; exit 1; }
	@$(COMPOSE) down -v

# --- development -------------------------------------------------------------

dev: ## Run every app with hot reload
	@$(PNPM) dev

build: ## Build every package and app
	@$(PNPM) build

# --- quality -----------------------------------------------------------------

verify: ## The gate: typecheck, lint, coverage, build. Nothing ships red.
	@$(PNPM) verify

typecheck: ## Typecheck every package
	@$(PNPM) typecheck

lint: ## Lint the repository
	@$(PNPM) lint

test: ## Run the test suite with coverage thresholds
	@$(PNPM) test:coverage

format: ## Format the repository
	@$(PNPM) format

# --- data --------------------------------------------------------------------

migrate: ## Apply Postgres migrations
	@$(PNPM) --filter @morph/core run db:migrate

seed: ## Load the surface registry and synthetic behaviour
	@$(PNPM) --filter @morph/worker run seed

shell-db: ## psql into Postgres
	@$(COMPOSE) exec postgres psql -U morph -d morph

shell-ch: ## clickhouse-client into ClickHouse
	@$(COMPOSE) exec clickhouse clickhouse-client --database morph

# --- the interesting bits ----------------------------------------------------

sim: ## Run the bandit convergence harness
	@$(PNPM) sim

report: ## Print a worked example of the hourly Telegram report
	@$(PNPM) report:sample

load-test: ## k6 against the ingest endpoint (see docs/BENCHMARKS.md)
	@k6 run infra/k6/ingest.js
