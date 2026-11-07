# Convenience targets for local development.
#
#   make start   install what is missing, then run the stub bridge and the web client
#   make stop    stop a stub bridge or web client left running in the background
#   make help    list the targets
#
# Written for GNU Make 3.81, the version macOS ships.

SHELL         := /bin/bash
.DEFAULT_GOAL := start

NODE_MAJOR := 20
STUB_PORT  := 7070
STAMP      := node_modules/.make-install-stamp
OPEN       ?= 1

# --- Node 20 -----------------------------------------------------------------
# The project requires Node 20 (and therefore npm 10). If nvm has a Node 20
# installed, put it first on PATH for every recipe here. The default Node of
# your shell is left untouched. Without nvm, the Node already on PATH is used.
NVM_DIR  ?= $(HOME)/.nvm
NODE_BIN := $(shell [ -s "$(NVM_DIR)/nvm.sh" ] && . "$(NVM_DIR)/nvm.sh" >/dev/null 2>&1 && \
              nvm which $(NODE_MAJOR) 2>/dev/null)
ifneq ($(NODE_BIN),)
export PATH := $(dir $(NODE_BIN)):$(PATH)
endif

.PHONY: start stop install help _check-node _check-stub-port

help:
	@echo "make start   run Dynadoc (stub bridge + web client)"
	@echo "make stop    stop Dynadoc processes left running in the background"
	@echo "make install (re)install dependencies"
	@echo ""
	@echo "Options: make start OPEN=0   do not open the browser"

# --- start -------------------------------------------------------------------
# Same pair of processes as `npm run stub-bridge` + `npm run dev:web:stub`, in
# one terminal. Ctrl+C stops both.
start: _check-node install .env.local _check-stub-port
	@echo "▶ Stub bridge on http://127.0.0.1:$(STUB_PORT) (data in ~/.dynadoc-stub)"
	@trap 'kill $$STUB_PID 2>/dev/null' EXIT; \
	node tools/stub-bridge/server.mjs & STUB_PID=$$!; \
	for i in $$(seq 1 50); do \
	  (: </dev/tcp/127.0.0.1/$(STUB_PORT)) 2>/dev/null && break; \
	  kill -0 $$STUB_PID 2>/dev/null || { echo "✗ The stub bridge did not start (see above)."; exit 1; }; \
	  sleep 0.2; \
	done; \
	echo "▶ Web client (Vite). The first load takes about a minute. If the page"; \
	echo "  errors after \"re-optimized dependencies\", reload it once. Ctrl+C stops everything."; \
	npm run --silent dev:web:stub -- $(if $(filter 1,$(OPEN)),--open,)

# --- stop --------------------------------------------------------------------
# The [t] and [v] keep pgrep from matching the shell running this recipe.
stop:
	@pids=$$(pgrep -f '[t]ools/stub-bridge/server.mjs|[v]ite --config web.vite.config.mts' || true); \
	if [ -n "$$pids" ]; then kill $$pids && echo "✓ Dynadoc processes stopped"; \
	else echo "Nothing to stop"; fi

# --- install -----------------------------------------------------------------
# --ignore-scripts: the web client needs none of the desktop build's native
# modules (see tools/stub-bridge/README.md). It skips the Chrome download
# (puppeteer), the Electron binary download and electron-rebuild, which are
# the usual causes of a failed install. The desktop app (`npm run dev`) needs
# a full `npm ci` instead.
install: _check-node $(STAMP)

$(STAMP): package-lock.json
	@echo "▶ Installing dependencies (a few minutes the first time)…"
	@PUPPETEER_SKIP_DOWNLOAD=true npm ci --ignore-scripts --no-audit --no-fund
	@npx --no-install husky >/dev/null 2>&1 || true
	@touch $@

# Created once; your edits are never overwritten.
.env.local: | .env.example
	@cp .env.example $@
	@echo "✓ .env.local created from .env.example"

# --- checks ------------------------------------------------------------------
_check-node:
	@v=$$(node -v 2>/dev/null); \
	case "$$v" in \
	  v$(NODE_MAJOR).*) ;; \
	  *) echo "✗ Node $(NODE_MAJOR) is required, found: $${v:-none}."; \
	     echo "  With nvm: nvm install $(NODE_MAJOR), then run make start again."; \
	     exit 1 ;; \
	esac

# Refuse rather than kill: a stub on the port may belong to a `make start`
# still running in another terminal.
_check-stub-port:
	@pid=$$(lsof -ti tcp:$(STUB_PORT) -sTCP:LISTEN 2>/dev/null | head -1); \
	if [ -n "$$pid" ]; then \
	  echo "✗ Port $(STUB_PORT) is already in use:"; \
	  ps -o pid=,command= -p $$pid; \
	  echo "  If Dynadoc is already running in another terminal, use that one, or run make stop first."; \
	  exit 1; \
	fi
