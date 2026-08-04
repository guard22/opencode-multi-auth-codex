# opencode-multi-auth-codex

Open-source account routing and reliability tooling for OpenCode's Codex OAuth
integration. It provides local session controls, a localhost dashboard,
configurable routing, limit visibility, and failure recovery.

[![npm version](https://img.shields.io/npm/v/@guard22/opencode-multi-auth-codex)](https://www.npmjs.com/package/@guard22/opencode-multi-auth-codex)
[![license](https://img.shields.io/github/license/floze-the-genius/opencode-multi-auth-codex)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/floze-the-genius/opencode-multi-auth-codex)](https://github.com/floze-the-genius/opencode-multi-auth-codex/stargazers)

<img width="1659" height="888" alt="image" src="https://github.com/user-attachments/assets/c72b4d04-be1b-4222-9094-454c2105336f" />

## Documentation map

- `README.md` -> primary operator and developer documentation for current behavior.
- `docs/ADMIN_MERGE_BRIEF.md` -> concise upstream/admin review summary.
- `docs/PHASE_H_VALIDATION.md` -> final validation report (current readiness reference).
- `codextesting.md` -> live/manual testing runbook.
- `docs/README.md` -> full docs index with authoritative vs historical references.

## What this project does

- Rotates requests across multiple ChatGPT/Codex OAuth accounts.
- Keeps a local account store with migration, validation, and atomic writes.
- Provides a localhost dashboard to manage accounts and limits.
- Supports force mode (pin one alias), account enable/disable, and re-auth.
- Supports settings-driven rotation strategy (`round-robin`, `least-used`, `random`, `weighted-round-robin`).
- Probes limits safely and keeps authoritative data quality rules.
- Gates non-core Antigravity features behind a feature flag.

## Current implementation status

- Core phases A-G are implemented in this workspace.
- Validation scripts are available for: unit, integration, web-headless, failure, stress, sandbox, soak.
- Web hardening fixes are in place:
  - localhost-only bind enforcement
  - malformed JSON returns deterministic `400` without process crash
  - dashboard client script parse issue fixed

## Behavior guarantees (latest)

- Rate-limit handling sleeps an alias until reset when reset timing is known (`Retry-After`, rate-limit window reset, or parsed provider reset text), instead of retrying that alias immediately.
- Force mode is strict: when enabled, requests stay pinned to the forced alias and do not silently fall back to other aliases.
- Rotation strategy control is shown next to Force Mode in the dashboard.
- Strategy changes from dashboard settings are applied to runtime selection logic (not just persisted state/UI display).
- Force Mode and strategy interaction is explicit:
  - while Force Mode is ON, strategy changes are saved
  - saved strategy becomes active when Force Mode is turned OFF
- Dashboard controls include mouseover help text for Force Mode and rotation strategy definitions.
- Account enable/disable toggle is authoritative for eligibility in rotation.

## Rotation strategy reference

- `round-robin` -> cycle through healthy enabled accounts in order.
- `least-used` -> prefer the healthy enabled account with the lowest usage count.
- `random` -> pick randomly from healthy enabled accounts.
- `weighted-round-robin` -> split traffic by configured account weights (example: `0.70/0.20/0.10` ≈ `70%/20%/10%`).
- Force Mode precedence -> when Force Mode is ON, strategy is paused; strategy changes are saved and become active when Force Mode is OFF.

## Repository structure

- `src/` -> TypeScript source
- `dist/` -> compiled output (`tsc` generated)
- `tests/unit/` -> unit tests
- `tests/integration/` -> integration tests
- `tests/web-headless/` -> headless UI smoke tests
- `tests/failure/` -> failure-injection tests
- `tests/stress/` -> stress/concurrency tests
- `tests/sandbox/` -> sandbox isolation tests
- `tests/soak/` -> soak scaffolding
- `docs/` -> QA and phase documentation (see `docs/README.md` for canonical/historical split)
- `IMPLEMENTATION_PLAN.md` -> full plan and contracts
- `TEST_EXECUTION_PLAN.md` -> required test order and gates
- `codextesting.md` -> live testing TODO for Codex CLI sessions

## Requirements

- Node.js 20+
- npm
- OpenCode CLI
- ChatGPT/Codex OAuth accounts

## Install and use

### Plugin install (recommended)

Install from npm:

```bash
opencode plugin @guard22/opencode-multi-auth-codex@latest --global
```

If you prefer config-based installation, OpenCode also supports:

```json
{
  "plugin": ["@guard22/opencode-multi-auth-codex@latest"]
}
```

Package:
- npm: [@guard22/opencode-multi-auth-codex](https://www.npmjs.com/package/@guard22/opencode-multi-auth-codex)
- repo: [floze-the-genius/opencode-multi-auth-codex](https://github.com/floze-the-genius/opencode-multi-auth-codex)

### GitHub source install (fallback)

Use this if you want the repo head instead of the latest npm release:

```bash
opencode plugin github:floze-the-genius/opencode-multi-auth-codex --global
```

```json
{
  "plugin": ["github:floze-the-genius/opencode-multi-auth-codex"]
}
```

OpenCode support:
- GPT-5.5 may appear in Codex before OpenCode ships built-in model metadata
- the plugin backfills `gpt-5.5` and `gpt-5.5-fast` into runtime config by default
- OpenCode builds that validate model IDs before plugin config is applied may still reject direct `openai/gpt-5.5` selection
- in that case, keep selecting `openai/gpt-5.4` and enable latest-model mapping:

```bash
export OPENCODE_MULTI_AUTH_PREFER_CODEX_LATEST=1
```

- `gpt-5.4` remains available and can be selected or used as a rollback target
- disable runtime model injection only if you explicitly want that behavior off:

```bash
export OPENCODE_MULTI_AUTH_INJECT_MODELS=0
```

Update existing installs:
- npm install: rerun `opencode plugin @guard22/opencode-multi-auth-codex@latest --global`
- GitHub install: rerun `opencode plugin github:floze-the-genius/opencode-multi-auth-codex --global`
- restart OpenCode after updating the plugin
- if your install is pinned to a specific tag/commit, bump it explicitly before testing new models

### From source

```bash
git clone https://github.com/floze-the-genius/opencode-multi-auth-codex.git
cd opencode-multi-auth-codex
npm ci
npm run build
```

### Quick start

```bash
# Add accounts
opencode-multi-auth add personal
opencode-multi-auth add work

# Check status
opencode-multi-auth status

# Start dashboard
opencode-multi-auth web --host 127.0.0.1 --port 3434
```

Open `http://127.0.0.1:3434`.

### Docker Compose

Account and credential data is bind-mounted from `./data/config`,
`./data/codex`, and `./data/codex-multi`, so it remains directly accessible on
the host. Override those locations with `OPENCODE_MULTI_AUTH_CONFIG_DIR`,
`OPENCODE_MULTI_AUTH_CODEX_DIR`, and
`OPENCODE_MULTI_AUTH_CODEX_ACCOUNTS_DIR`. Host directories must be writable by
UID/GID `1000:1000`, which is also the non-root identity used by the container.
The directories must exist because Compose will not create them automatically.
On a rootful native Linux Docker Engine without user-namespace remapping,
prepare their ownership before the first start:

```bash
sudo chown -R 1000:1000 data
```

With rootless Docker or user-namespace remapping, grant write access to the
host UID mapped from container UID 1000 instead, using host ownership or ACLs.

The bind mounts use private SELinux relabeling (`Z`), so custom paths should be
dedicated to this service.

If both services are forcibly terminated during a store write and startup later
reports a stale store lock, stop both services before removing
`data/config/opencode-multi-auth/accounts.json.lock`.

To encrypt `accounts.json` at rest, set
`CODEX_SOFT_STORE_PASSPHRASE` for the Compose service through your deployment's
secret-management mechanism.

The image includes the Codex CLI and Chromium used by limit probes. The container can reach
services running on the Docker host through `host.docker.internal`. On native
Linux, the host service must listen on an address reachable from Docker's
bridge rather than only `127.0.0.1`.

#### Migrating from named volumes

If you ran the earlier Compose configuration, stop it and copy each old named
volume into its replacement bind directory before starting this version. Find
the project prefix with `docker volume ls`, then replace `<project>` below:

```bash
docker compose down
docker run --rm -v <project>_app_config:/from:ro -v "$PWD/data/config:/to:Z" alpine cp -a /from/. /to/
docker run --rm -v <project>_codex_auth:/from:ro -v "$PWD/data/codex:/to:Z" alpine cp -a /from/. /to/
docker run --rm -v <project>_codex_accounts:/from:ro -v "$PWD/data/codex-multi:/to:Z" alpine cp -a /from/. /to/
```

Apply the ownership guidance above after copying. Keep the old named volumes
until the bind-mounted deployment has been verified.

After preparing the directories and migrating any existing data, build and
start the dashboard and OpenAI-compatible API. Set a strong API key in `.env`
first:

```bash
OPENCODE_MULTI_AUTH_API_KEY=replace-with-a-long-random-value
```

```bash
docker compose up --build -d
```

Open `http://127.0.0.1:3434`. The dashboard and OAuth callback ports are
published on host loopback only because the dashboard manages credentials and
does not provide application-level authentication. Use an SSH tunnel when
accessing it from another machine; do not publish it directly on a LAN or
public interface. OAuth callbacks use port `1455` while a login is pending.
The container pins `OPENCODE_MULTI_AUTH_REDIRECT_PORTS=1455`; non-container
launches retain the `1455-1459` fallback range.

The OpenAI Codex OAuth client accepts only its registered localhost callback;
a public reverse-proxy URL cannot be used as the redirect URI. For a dashboard
opened from another machine, complete the OpenAI login normally. The browser
will finish at `http://localhost:1455/auth/callback` and may show that it cannot
connect. Copy the full URL from the browser address bar, return to the pending
login in the dashboard, paste it into the callback field, and select
**Complete login**. The dashboard validates the callback state and submits the
authorization code to the active PKCE flow. The callback URL contains a
one-time credential, so submit it only to your authenticated dashboard.

The API listens at `http://127.0.0.1:3435` and uses the same account store as
the dashboard. Send its key as `Authorization: Bearer <key>` or `x-api-key`.
Override the host ports with `OPENCODE_MULTI_AUTH_PORT` and
`OPENCODE_MULTI_AUTH_API_PORT`.

### Standalone API service (experimental)

Start an OpenAI-compatible local API service backed by the same multi-account Codex rotation runtime:

```bash
export OPENCODE_MULTI_AUTH_API_KEY="change-me"
opencode-multi-auth api --host 127.0.0.1 --port 3435
```

Endpoints:

- `GET /api/health`
- `GET /v1/models`
- `POST /v1/responses`
- `POST /v1/chat/completions`

Use `Authorization: Bearer $OPENCODE_MULTI_AUTH_API_KEY` for `/v1/*` routes. An API key is always required. Remote binding is additionally blocked unless `OPENCODE_MULTI_AUTH_ALLOW_REMOTE_API=1` is set.

## CLI commands

- `opencode-multi-auth add <alias>` -> add account via OAuth
- `opencode-multi-auth remove <alias>` -> remove account
- `opencode-multi-auth list` -> list configured accounts
- `opencode-multi-auth status` -> full status
- `opencode-multi-auth path` -> print store path
- `opencode-multi-auth web --host 127.0.0.1 --port 3434` -> run dashboard
- `opencode-multi-auth service install|disable|status` -> systemd user service helpers

## Dashboard/API endpoints

- `GET /api/state`
- `GET /api/logs`
- `POST /api/sync`
- `POST /api/auth/start`
- `POST /api/auth/cancel`
- `POST /api/switch`
- `POST /api/remove`
- `POST /api/account/meta`
- `POST /api/token/refresh`
- `POST /api/limits/refresh`
- `POST /api/limits/stop`
- `GET /api/accounts`
- `PUT /api/accounts/:alias/enabled`
- `POST /api/accounts/:alias/reauth`
- `GET /api/force`
- `POST /api/force`
- `POST /api/force/clear`
- `GET /api/settings`
- `PUT /api/settings`
- `GET /api/settings/feature-flags`
- `PUT /api/settings/feature-flags`
- `POST /api/settings/reset`
- `POST /api/settings/preset`
- `POST /api/antigravity/refresh` (feature-flag gated)
- `POST /api/antigravity/refresh-all` (feature-flag gated)

## Environment variables

### Storage and auth

- `OPENCODE_MULTI_AUTH_STORE_DIR` -> override store directory
- `OPENCODE_MULTI_AUTH_STORE_FILE` -> override store file path
- `OPENCODE_MULTI_AUTH_CODEX_AUTH_FILE` -> override Codex `auth.json`
- `CODEX_SOFT_STORE_PASSPHRASE` -> encrypt account store at rest
- `CODEX_SOFT_LOG_PATH` -> override dashboard log path
- `OPENCODE_MULTI_AUTH_ALLOW_REMOTE_HOST=1` -> allow a non-loopback bind (intended for containers behind a loopback-published port)

### Rotation and limits

- `OPENCODE_MULTI_AUTH_ROTATION_STRATEGY` (settings source override; runtime rotation follows persisted dashboard settings)
- `OPENCODE_MULTI_AUTH_CRITICAL_THRESHOLD`
- `OPENCODE_MULTI_AUTH_LOW_THRESHOLD`
- `OPENCODE_MULTI_AUTH_TOKEN_FAILURE_COOLDOWN_MS`
- `OPENCODE_MULTI_AUTH_PROBE_EFFORT`
- `OPENCODE_MULTI_AUTH_LIMITS_PROBE_MODELS`

### Model mapping and runtime behavior

- `OPENCODE_MULTI_AUTH_PREFER_CODEX_LATEST`
- `OPENCODE_MULTI_AUTH_CODEX_LATEST_MODEL`
- `OPENCODE_MULTI_AUTH_INJECT_MODELS`
- `OPENCODE_MULTI_AUTH_TRUNCATION`
- `OPENCODE_MULTI_AUTH_DEBUG`

## Latest Codex Mapping

The plugin can route older Codex selections to the latest Codex backend model when you explicitly opt in.

Default behavior:
- exact model selection is preserved

Environment variables:
- `OPENCODE_MULTI_AUTH_PREFER_CODEX_LATEST=1` enables mapping to the latest backend model
- `OPENCODE_MULTI_AUTH_CODEX_LATEST_MODEL=gpt-5.4` overrides the mapping target, for example to roll back from the default `gpt-5.5`
- `OPENCODE_MULTI_AUTH_DEBUG=1` prints model mapping debug logs
- `OPENCODE_MULTI_AUTH_INJECT_MODELS=0` disables automatic runtime model backfill

## Fast Mode

For OpenCode builds that already accept `gpt-5.5` model IDs, the clean way to mirror Codex Fast mode is:

- keep the model as `openai/gpt-5.5`
- use a model variant such as `fast`
- set `serviceTier=priority` in the variant config

Behavior:
- the backend model stays `gpt-5.5`
- the plugin forwards the request with `service_tier=priority`
- the plugin does not automatically lower reasoning or verbosity

Recommended OpenCode config:

```json
{
  "provider": {
    "openai": {
      "models": {
        "gpt-5.5": {
          "variants": {
            "Medium Fast": {
              "reasoningEffort": "medium",
              "serviceTier": "priority"
            },
            "High Fast": {
              "reasoningEffort": "high",
              "serviceTier": "priority"
            },
            "XHigh Fast": {
              "reasoningEffort": "xhigh",
              "serviceTier": "priority"
            }
          }
        }
      }
    }
  }
}
```

For OpenCode builds that still reject `openai/gpt-5.5`, keep selecting `openai/gpt-5.4`, keep your existing Fast variant, and set `OPENCODE_MULTI_AUTH_PREFER_CODEX_LATEST=1`. The plugin will send `gpt-5.5` to the Codex backend while preserving `service_tier=priority`.

See [docs/gpt-5.4-fast-benchmark.md](./docs/gpt-5.4-fast-benchmark.md) for a continued-session benchmark summary.

### Feature flags

- `OPENCODE_MULTI_AUTH_ANTIGRAVITY_ENABLED`

### Notifications

- `OPENCODE_MULTI_AUTH_NOTIFY=1` enables optional completion/retry/error notifications. Notifications are off by default so they cannot delay normal `opencode run` lifecycle.
- `OPENCODE_MULTI_AUTH_NOTIFY_SOUND`
- `OPENCODE_MULTI_AUTH_NOTIFY_MAC_OPEN`
- `OPENCODE_MULTI_AUTH_NOTIFY_NTFY_URL`
- `OPENCODE_MULTI_AUTH_NOTIFY_NTFY_TOKEN`
- `OPENCODE_MULTI_AUTH_NOTIFY_UI_BASE_URL`

## Security rules

- Dashboard host is loopback-only (`127.0.0.1`, `::1`, `localhost`).
- Non-loopback host bind is rejected.
- Sensitive token patterns are redacted in logs.
- Store file permissions are restricted (`0o600`).
- Antigravity APIs are blocked when feature flag is off.

## Build and test

```bash
npm ci
npm run lint
npm run build
npx tsc --noEmit

npm run test:unit
npm run test:integration
npm run test:web:headless
npm run test:failure
npm run test:stress
npm run test:sandbox
npm run test:soak:48h
```

Current test script surfaces are scaffolded and active. For true long soak, set a long duration and keep the run alive.

## Live validation runbook

Use `codextesting.md` for the Codex CLI live-testing checklist and copy-paste command flow.

## Troubleshooting

- If dashboard start fails with localhost error, check `--host` and use loopback only.
- If a request returns `INVALID_JSON`, verify payload body is valid JSON.
- If an alias action returns `ACCOUNT_NOT_FOUND`, refresh account list first.
- If re-auth is blocked with `ACCOUNT_DISABLED`, enable the account before re-auth.
- If encrypted store appears locked, export `CODEX_SOFT_STORE_PASSPHRASE` before launching.

## Development notes

- Edit `src/*`, never hand-edit `dist/*`.
- Run `npm run build` after source changes.
- Keep manual/live tests sandboxed (temp HOME/store/auth paths).

## Release flow

- This plugin is now intended to be installed from npm, so every shipped update should bump `package.json` version and publish a new package version. Reusing the same version on a new commit will leave users stuck on cached installs.
- Prepare the next release by bumping the package version, rebuilding, and publishing:

```bash
npm version 1.2.1 --no-git-tag-version
npm install
npm run build
npm publish --access public
```

- After that, cut the git release from `main`:

```bash
git commit -m "chore: release v1.2.1"
git tag v1.2.1
git push origin main --follow-tags
```

- Users who want a pinned build can install a specific npm version:

```json
{
  "plugin": ["npm:@guard22/opencode-multi-auth-codex@1.2.1"]
}
```

- Users tracking `latest` should rerun the install command and restart OpenCode after a new package lands.

## License

MIT
