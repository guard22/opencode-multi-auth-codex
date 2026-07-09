# Custom Multi-Auth API Service PRD and Implementation Plan

## Status

- Owner: fork-specific implementation.
- Current phase: feasibility and product planning.
- Decision: feasible on top of this repository.
- Last updated: 2026-07-10.

## Feasibility Summary

This repository is a practical base for a standalone API service. The core account and token logic is already separated from OpenCode-specific code in reusable TypeScript modules:

- `src/store.ts` manages the encrypted/local account store, validation, migration, atomic writes, and account metadata.
- `src/auth.ts` implements OpenAI OAuth login, token refresh, and token validity checks.
- `src/rotation.ts` selects the next healthy account, respects force mode, skips blocked accounts, and updates usage state.
- `src/rate-limits.ts`, `src/usage-limits.ts`, `src/limits-refresh.ts`, and `src/probe-limits.ts` support provider limit detection and limit state.
- `src/models.ts` supplies model metadata and Codex model variants.
- `src/web.ts` already exposes a localhost dashboard API for account management, force mode, settings, token refresh, and limits refresh.

The main OpenCode-specific part is currently concentrated in `src/index.ts`, especially the nested `customFetch` inside the plugin `auth.loader`. That code performs the LLM request proxying: request body normalization, model mapping, ChatGPT backend URL rewriting, token/account selection, backend headers, streaming handling, and retry/fallback behavior.

The recommended architecture is to extract that request proxying logic into a reusable runtime module, then use it from both:

- a new standalone HTTP API service, and
- the existing OpenCode plugin, either directly or as a thin client to the API service.

## Key Risks

- The upstream target is the ChatGPT/Codex backend (`https://chatgpt.com/backend-api`), not a stable public OpenAI API. Breakage risk remains if backend paths, headers, token claims, or model behavior change.
- Current request proxy logic is embedded in `src/index.ts`; it must be extracted carefully to avoid changing OpenCode behavior during the first service phase.
- The existing dashboard server is intentionally localhost-only. A remotely exposed API service requires authentication, token redaction, network binding policy, and deployment guidance before it is safe.
- Multi-client usage can increase concurrent requests and store writes. The existing store has atomic writes and an in-process lock, but a long-running service should centralize writes in one process or add stronger cross-process locking later.

## Product Requirement Document

### Problem

The project currently works mainly as an OpenCode provider/plugin. We want a standalone web API that centralizes multi-account ChatGPT/Codex OAuth rotation and exposes an OpenAI-compatible API surface so multiple clients can consume it, including OpenCode, Hermes, scripts, and other local/remote tools.

### Goals

- Expose a web service that accepts OpenAI-style requests and routes them through the existing multi-account Codex logic.
- Preserve existing OpenCode plugin behavior while enabling OpenCode to use the service as an external provider.
- Support other clients through a documented, stable local API contract.
- Reuse the existing store, OAuth, rotation, force mode, settings, model mapping, and rate-limit handling.
- Keep secrets server-side. Clients should use service API keys, not raw ChatGPT OAuth tokens.
- Keep the existing dashboard and account-management workflows available.

### Non-Goals For The First Release

- No multi-tenant hosted SaaS model.
- No database migration away from the current file store in the first release.
- No browser UI redesign beyond minor changes needed to show service status.
- No guarantee that unofficial ChatGPT backend behavior is stable.
- No automatic remote TLS certificate management; use a reverse proxy for production exposure.

### Primary Users

- Local operator who manages multiple ChatGPT/Codex OAuth accounts.
- OpenCode user who wants the same rotation logic without coupling every request to the plugin runtime.
- Hermes or other client user that can point at an OpenAI-compatible base URL.
- Automation/scripts that need centralized model access and account rotation.

### API Surface

#### OpenAI-Compatible Inference API

Minimum required endpoints:

- `GET /v1/models`
- `POST /v1/responses`
- `POST /v1/chat/completions`

Behavior requirements:

- Accept `Authorization: Bearer <service-api-key>`.
- Do not accept or require raw ChatGPT OAuth tokens from clients.
- Rewrite supported OpenAI-compatible paths to ChatGPT Codex backend paths.
- Normalize model names using the existing logic currently in `src/index.ts`.
- Preserve streaming responses when `stream: true`.
- Convert SSE to JSON for non-streaming requests when the upstream response is SSE.
- Return deterministic JSON errors for no accounts, max retries, invalid service auth, rate-limit exhaustion, request parsing failures, and backend failures.

#### Management API

Minimum required endpoints:

- `GET /api/health`
- `GET /api/state`
- `GET /api/accounts`
- `POST /api/auth/start`
- `POST /api/token/refresh`
- `POST /api/limits/refresh`
- `GET /api/force`
- `POST /api/force`
- `POST /api/force/clear`
- `GET /api/settings`
- `PUT /api/settings`

The existing dashboard API in `src/web.ts` already covers most management requirements. The first implementation should avoid duplicating that surface and should either reuse handlers or share a small routing layer.

### Security Requirements

- Require a service API key for inference endpoints by default.
- Require an admin API key for mutating management endpoints when binding to anything other than loopback.
- Keep `127.0.0.1` as the safe default bind address.
- Refuse non-loopback binding unless explicit environment/config flags and API keys are set.
- Redact OAuth tokens, refresh tokens, API keys, and authorization headers in logs and errors.
- Disable permissive CORS by default.
- Document reverse-proxy TLS as the recommended remote exposure pattern.

### Configuration Requirements

Environment variables should include:

- `OPENCODE_MULTI_AUTH_API_HOST`, default `127.0.0.1`.
- `OPENCODE_MULTI_AUTH_API_PORT`, default `3435`.
- `OPENCODE_MULTI_AUTH_API_KEY`, required for inference auth outside development.
- `OPENCODE_MULTI_AUTH_ADMIN_KEY`, required for remote management mutations.
- `OPENCODE_MULTI_AUTH_ALLOW_REMOTE_API`, default `0`.
- Existing store/model/probe/debug variables should continue to work.

### OpenCode Integration Requirement

Two modes should be supported:

- Embedded mode: current plugin behavior continues by importing the shared runtime directly.
- Service mode: plugin delegates to the standalone API service, or OpenCode is configured with a custom OpenAI-compatible provider pointing to the service base URL.

### Hermes Integration Requirement

Hermes should be able to use the service if it supports an OpenAI-compatible `baseURL` plus bearer token configuration. The service should not require Hermes-specific protocol changes for the first release.

## Target Architecture

### Proposed Modules

- `src/codex-proxy.ts`: shared request runtime extracted from `src/index.ts`.
- `src/api-server.ts`: standalone HTTP server for `/v1/*` inference and `/api/*` management routes.
- `src/http-utils.ts`: shared JSON body parsing, response helpers, auth helpers, and error formatting.
- `src/index.ts`: OpenCode plugin becomes a caller of `codex-proxy.ts` instead of owning the proxy implementation.
- `src/cli.ts`: add `api` or `serve` command to launch the standalone service.

### Request Flow

1. Client sends `POST /v1/responses` or `POST /v1/chat/completions` with service bearer token.
2. API server authenticates the service key.
3. API server passes request data to `codex-proxy.ts`.
4. Proxy runtime loads settings and selects the next eligible account through `getNextAccount`.
5. Proxy runtime ensures token validity and sets ChatGPT/Codex backend headers.
6. Proxy runtime forwards the request to `https://chatgpt.com/backend-api`.
7. Proxy runtime updates rate-limit/account state from upstream response headers or errors.
8. API server streams or returns the response to the client.

## Implementation Plan

### Phase 0: Review And Lock Requirements

- [ ] Review this document with the repo owner.
- [ ] Confirm required client targets: OpenCode, Hermes, and any other concrete clients.
- [ ] Confirm whether the first release is local-only or remotely exposed behind a reverse proxy.
- [ ] Confirm service auth model and environment variable names.

### Phase 1: Extract Shared Proxy Runtime

- [ ] Move request transformation helpers from `src/index.ts` to `src/codex-proxy.ts`.
- [ ] Move account selection, upstream forwarding, retry/fallback, rate-limit marking, and SSE conversion into a reusable function.
- [ ] Keep `src/index.ts` behavior unchanged by calling the new shared function from the OpenCode plugin `customFetch`.
- [ ] Add unit tests around model normalization, path rewriting, payload transformation, retry limits, and SSE conversion.
- [ ] Run `npm run build` and relevant unit tests.

### Phase 2: Add Standalone Inference API

- [ ] Add `src/api-server.ts` with `GET /v1/models`, `POST /v1/responses`, and `POST /v1/chat/completions`.
- [ ] Add bearer-token auth for `/v1/*` endpoints.
- [ ] Add deterministic JSON error mapping.
- [ ] Add streaming passthrough tests and non-streaming SSE-to-JSON tests.
- [ ] Add `opencode-multi-auth api --host --port` or `serve` CLI command.

### Phase 3: Share Or Consolidate Management API

- [ ] Extract reusable management route handlers from `src/web.ts` or mount existing handlers into the API server.
- [ ] Add `GET /api/health` with service version, store status, account count, active alias, and feature flags.
- [ ] Require admin auth for mutating management routes when remote mode is enabled.
- [ ] Keep dashboard localhost behavior intact.

### Phase 4: OpenCode And Hermes Consumption

- [ ] Document OpenCode custom provider configuration for service mode.
- [ ] Optionally add plugin service mode that delegates to the local API instead of embedding the proxy.
- [ ] Document Hermes base URL and bearer token configuration once its exact expected config shape is confirmed.
- [ ] Add smoke tests with a mock client using OpenAI-compatible request shapes.

### Phase 5: Deployment Hardening

- [ ] Add reverse-proxy example for remote exposure.
- [ ] Add systemd service support for the API server command.
- [ ] Add log redaction tests for headers and token-like values.
- [ ] Add concurrency tests for multiple simultaneous `/v1/responses` requests.
- [ ] Add operational docs for store backup, encryption passphrase, and restart behavior.

## Acceptance Criteria

- `npm run build` passes.
- Existing OpenCode plugin tests continue to pass.
- A local client can call `POST /v1/responses` against the service and receive a valid response through account rotation.
- A local client can call `POST /v1/chat/completions` and the request is mapped to the Codex backend path.
- `stream: true` responses stream through without buffering the whole upstream response.
- Non-streaming requests receive JSON responses.
- The service skips rate-limited, disabled, auth-invalid, model-unsupported, and deactivated-workspace accounts using existing rules.
- The service never returns stored OAuth tokens in management responses.
- Remote binding is blocked unless explicitly enabled and protected by configured API keys.

## Initial Progress Tracker

- [x] Repository structure scanned.
- [x] Existing OpenCode plugin proxy flow identified in `src/index.ts`.
- [x] Existing account/OAuth/rotation/store modules identified as reusable.
- [x] Existing dashboard management API identified in `src/web.ts`.
- [x] Feasibility decision recorded.
- [ ] Requirements reviewed by repo owner.
- [ ] Shared proxy runtime implemented.
- [ ] Standalone inference API implemented.
- [ ] Management route sharing implemented.
- [ ] OpenCode service-mode docs implemented.
- [ ] Hermes integration docs implemented.
- [ ] Deployment hardening implemented.

## Open Questions For Review

- Should the first service release be local-only, or should remote exposure be included immediately?
- Should OpenCode keep using embedded plugin mode by default, or should the fork move toward service mode as the primary path?
- What exact Hermes configuration format should be documented and tested?
- Should service API keys be a single shared token for v1, or do we need multiple client keys with per-client labels and revocation?
- Should account store access remain file-based for now, or should a future phase introduce SQLite for stronger multi-process concurrency?
