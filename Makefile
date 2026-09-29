SHELL := /bin/bash
.DEFAULT_GOAL := help
.PHONY: help setup dev start up down app app-win app-linux test lint build check

help: ## Mostra esta lista
	@grep -hE '^[a-z-]+:.*?## ' $(MAKEFILE_LIST) | awk -F':.*?## ' '{printf "  \033[36m%-9s\033[0m %s\n", $$1, $$2}'

setup: ## Instala dependências e cria o .env
	@pnpm install
	@test -f .env || cp .env.example .env

dev: ## Sobe API e frontend (Ctrl+C para os dois)
	@trap 'kill 0' EXIT; pnpm server:dev & pnpm dev

# Rebuilds the page only when a source file changed since the last build.
dist/index.html: index.html vite.config.ts $(shell find src public -type f -not -path 'src/server/*')
	@pnpm exec vite build

start: dist/index.html ## Sobe só a API servindo o build em http://localhost:47832 (sem Vite)
	@PORT=47832 exec node --import tsx $(CURDIR)/src/server/index.ts

# setsid detaches from the terminal, so closing it no longer kills the server.
up: dist/index.html ## Igual ao start, mas em segundo plano (log em start.log)
	@if ss -ltn | grep -q ':47832 '; then echo "Já no ar: http://localhost:47832"; exit 0; fi; \
	PORT=47832 setsid nohup node --import tsx $(CURDIR)/src/server/index.ts > $(CURDIR)/start.log 2>&1 < /dev/null & pid=$$!; \
	until ss -ltn | grep -q ':47832 '; do \
		kill -0 $$pid 2>/dev/null || { tail -n 20 $(CURDIR)/start.log; exit 1; }; sleep 0.5; \
	done; echo "No ar: http://localhost:47832"

down: ## Para o servidor do make up (grava o cache antes de sair)
	@pkill -f '$(CURDIR)/[s]rc/server/index.ts' && echo "Parado" || echo "Não estava rodando"

# Same idea for the server the desktop app loads: TypeScript compiled only when a source changed.
build/server/index.js: tsconfig.server.json $(shell find src/server -name '*.ts' -not -name '*.test.ts')
	@pnpm exec tsc -p tsconfig.server.json

app: dist/index.html build/server/index.js ## Abre o painel como app de desktop (Electron)
	@pnpm exec electron .

app-win: dist/index.html build/server/index.js ## Gera o instalador do Windows em release/ (rode no Windows)
	@pnpm exec electron-builder --win

app-linux: dist/index.html build/server/index.js ## Gera o AppImage do Linux em release/ (rode no Linux)
	@pnpm exec electron-builder --linux

test: ## Roda os testes
	@pnpm test

lint: ## Roda o oxlint
	@pnpm lint

build: ## Typecheck e build do frontend
	@pnpm build

check: test lint build ## Tudo que precisa passar
