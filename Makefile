# All development commands run in containers, so nothing is installed on the host.
# The Makefile runs on the host; inside the containers it only calls npm and node.
# Every target uses a one-off container with docker compose run --rm and leaves no container
# behind (except make dev).

# Used by compose.yaml for the container user and the owner of the named volumes
export UID := $(shell id -u)
export GID := $(shell id -g)

# Node version. Switch it like make test NODE_VERSION=24 (the CI matrix does the same)
NODE_CURRENT := 26
# Lower bound of engines.node. Unit and integration tests also run on this version
NODE_LOWER := 22.12.0
# The lowest Node that the Astro in the lockfile and the lowest supported Astro (peer dependency)
# require. E2E also runs on this version
NODE_E2E_LOWER := 22.23.4
NODE_VERSION ?= $(NODE_CURRENT)
NODE_MODULES ?= node_modules
export NODE_VERSION NODE_MODULES

COMPOSE := docker compose --progress quiet
# $(call run_on,<Node version>,<volume>) <command>: runs a command in a one-off container
run_on = NODE_VERSION=$(1) NODE_MODULES=$(2) $(COMPOSE) run --rm --build --quiet-build --quiet-pull -T node
RUN = $(call run_on,$(NODE_VERSION),$(NODE_MODULES))

.PHONY: down install build typecheck lint format smoke test e2e check matrix \
	e2e-latest e2e-min e2e-pack e2e-pack-pnpm pack shell dev dev-stop dev-logs test-dev

# Stops and removes this project's containers (including profile services; named volumes are kept)
down:
	$(COMPOSE) --profile '*' down

# npm ci if there is a lockfile, npm install otherwise. node_modules is shared by all Node versions
install:
	$(RUN) sh -c 'if [ -f package-lock.json ]; then npm ci; else npm install; fi'

build:
	$(RUN) npm run build

typecheck:
	$(RUN) npm run typecheck

lint:
	$(RUN) npm run lint

format:
	$(RUN) npm run format

# Unit and integration tests
test:
	$(RUN) npm test

# Build, then E2E
e2e:
	$(RUN) sh -c 'npm run build && npm run e2e'

# The local standard: type checks and lint, test and e2e on Node 26, and test and e2e on the
# lowest Node versions
check: typecheck lint
	$(MAKE) --no-print-directory test e2e NODE_VERSION=$(NODE_CURRENT)
	$(MAKE) --no-print-directory test NODE_VERSION=$(NODE_LOWER)
	$(MAKE) --no-print-directory e2e NODE_VERSION=$(NODE_E2E_LOWER)

# Checks on three versions (before a release, for example). CI may instead call test and e2e with
# different NODE_VERSION values
matrix: typecheck lint
	@for v in $(NODE_E2E_LOWER) 24 $(NODE_CURRENT); do \
	  echo "== Node $$v"; \
	  $(MAKE) --no-print-directory test e2e NODE_VERSION=$$v || exit 1; \
	done
	$(MAKE) --no-print-directory test NODE_VERSION=$(NODE_LOWER)

# Converts the same document on each Node version and compares the outputs and stderr, to check
# that @asciidoctor/core works on every supported Node without warnings (experimental features
# and so on)
SMOKE_VERSIONS := $(NODE_LOWER) $(NODE_E2E_LOWER) 24 $(NODE_CURRENT)
smoke:
	@mkdir -p .smoke
	@for v in $(SMOKE_VERSIONS); do \
	  echo "== Node $$v"; \
	  $(call run_on,$$v,$(NODE_MODULES)) sh -c "node test/smoke/smoke.mjs > .smoke/$$v.out 2> .smoke/$$v.err" || exit 1; \
	  if [ -s .smoke/$$v.err ]; then echo "stderr is not empty:"; cat .smoke/$$v.err; exit 1; fi; \
	  head -n 3 .smoke/$$v.out; \
	done
	@for v in $(SMOKE_VERSIONS); do cmp .smoke/$(NODE_CURRENT).out .smoke/$$v.out || exit 1; done \
	  && echo "smoke: outputs are identical on Node $(SMOKE_VERSIONS), and stderr is empty"

# Checks with the latest astro 7.x and @asciidoctor/core 4.x. Uses its own volume, so the usual
# node_modules is not replaced
e2e-latest:
	$(call run_on,$(NODE_CURRENT),node_modules_latest) sh -c 'npm ci \
	  && npm install --no-save astro@7 @asciidoctor/core@4 shiki@4 \
	  && (npm ls astro @asciidoctor/core shiki || true) && npm run build && npm test && npm run e2e'

# Checks with the lowest supported peer dependencies (astro 7.4.0, shiki 4.6.0,
# @asciidoctor/core 4.2.1) and the lowest Node for E2E
e2e-min:
	$(call run_on,$(NODE_E2E_LOWER),node_modules_min) sh -c 'npm ci \
	  && npm install --no-save astro@7.4.0 shiki@4.6.0 @asciidoctor/core@4.2.1 \
	  && (npm ls astro @asciidoctor/core shiki || true) && npm run build && npm test && npm run e2e'

# Installs the published tarball into an empty project with only Astro, and runs astro build
# (before a release, and in the scheduled workflow)
e2e-pack:
	$(RUN) npm run test:pack

# The same with pnpm (checks whether shiki has to be installed separately)
e2e-pack-pnpm:
	$(RUN) sh -c 'PACK_MANAGER=pnpm npm run test:pack'

# prepack removes dist and builds again, then lists the files that would be published
pack:
	$(RUN) npm pack --dry-run

shell:
	NODE_VERSION=$(NODE_VERSION) NODE_MODULES=$(NODE_MODULES) $(COMPOSE) run --rm --build node bash

# Runs test/fixtures/site with astro dev (open 127.0.0.1:$(DEV_PORT) on the host).
# The server runs until stopped, so only this target uses up -d. Remove it with make dev-stop or
# make down
DEV_PORT ?= 4321
dev: build
	DEV_PORT=$(DEV_PORT) NODE_VERSION=$(NODE_CURRENT) $(COMPOSE) --profile dev up -d --build dev
	@echo "astro dev: http://localhost:$(DEV_PORT)/ (stop with: make dev-stop)"

dev-stop:
	$(COMPOSE) --profile dev rm -s -f dev

dev-logs:
	$(COMPOSE) --profile dev logs -f dev

# Checks on a real astro dev server (test/dev/, opt-in)
test-dev: build
	$(RUN) npm run test:dev
