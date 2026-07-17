# opencode-multi-auth-codex

Multi-account OAuth rotation plugin for OpenCode with a local dashboard, force mode, weighted settings, limits probing, and reliability hardening.
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
- `auto-login/` -> Python script for bulk Outlook-based OAuth login

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
- repo: [guard22/opencode-multi-auth-codex](https://github.com/guard22/opencode-multi-auth-codex)

### GitHub source install (fallback)

Use this if you want the repo head instead of the latest npm release:

```bash
opencode plugin github:guard22/opencode-multi-auth-codex --global
```

```json
{
  "plugin": ["github:guard22/opencode-multi-auth-codex"]
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
- GitHub install: rerun `opencode plugin github:guard22/opencode-multi-auth-codex --global`
- restart OpenCode after updating the plugin
- if your install is pinned to a specific tag/commit, bump it explicitly before testing new models

### From source

```bash
git clone https://github.com/guard22/opencode-multi-auth-codex.git
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

Build and start the dashboard from this checkout:

```bash
docker compose up --build -d
```

Open `http://127.0.0.1:3434`. The dashboard and OAuth callback ports are
published on host loopback only because the dashboard manages credentials and
does not provide application-level authentication. Use an SSH tunnel when
accessing it from another machine; do not publish it directly on a LAN or
public interface.

Account and credential data is kept in the `app_config`, `codex_auth`, and
`codex_accounts` named volumes. The container runs as UID/GID `1000:1000` and
does not run as root. To encrypt `accounts.json` at rest, set
`CODEX_SOFT_STORE_PASSPHRASE` for the Compose service through your deployment's
secret-management mechanism.

The image includes the Codex CLI and the Python, Playwright, and Chromium
runtime used by limit probes and automated login.

## Automated Bulk Login (Outlook)

The `auto-login/` directory contains a standalone Python script that **automates the full OAuth login flow** for multiple Outlook-based ChatGPT accounts. Instead of manually running `opencode-multi-auth add` and clicking through the browser for each account, the script handles everything:

- Opens OpenAI auth page
- Enters email, requests a one-time login code
- Logs into Outlook Web to read the verification code
- Enters the code, clicks through the consent page
- Captures the OAuth tokens and writes them directly into the plugin store

### Prerequisites

- **Python 3.9+**
- **Playwright** (Python):
  ```bash
  pip install playwright
  playwright install chromium
  ```
- **Outlook.com accounts** linked to ChatGPT (the script reads OTP codes from Outlook Web)

### Setup

1. Copy the example credentials file:
   ```bash
   cp auto-login/credentials.example.json auto-login/credentials.json
   ```

2. Edit `auto-login/credentials.json` with your real accounts:
   ```json
   {
     "defaults": {
       "chatgpt_password": "SharedPasswordIfAny"
     },
     "accounts": [
       {
         "id": "acc-1",
         "email": "your-email@outlook.com",
         "outlook_password": "your-outlook-password",
         "chatgpt_password": "your-chatgpt-password",
         "enabled": true
       }
     ]
   }
   ```

   - `defaults.chatgpt_password` is used when an account doesn't specify its own.
   - `outlook_password` is required for reading OTP codes from Outlook inbox.
   - Set `enabled: false` to skip an account without removing it.

### Usage

```bash
# Check which accounts need login
python3 auto-login/auto_login.py --check

# Login all enabled accounts (headless)
python3 auto-login/auto_login.py

# Login a specific account by index
python3 auto-login/auto_login.py --account 0

# Login a specific account by email
python3 auto-login/auto_login.py --email user@outlook.com

# Run with visible browser (for debugging)
python3 auto-login/auto_login.py --visible
```

### How it works

```
OpenAI Auth                    Outlook Web                  Local Server
    |                              |                            |
    |  1. Enter email              |                            |
    |  2. Click "one-time code"    |                            |
    |  ----sends OTP email-------> |                            |
    |                              |  3. Login to Outlook       |
    |                              |  4. Read OTP from inbox    |
    |  5. Enter OTP code           |                            |
    |  6. Click Continue (consent) |                            |
    |  ----redirect callback-----> | ----code via HTTP GET----> |
    |                              |                            |  7. Capture code
    |                              |                            |  8. Exchange for tokens
    |                              |                            |  9. Write to plugin store
```

The script generates a PKCE challenge identical to the plugin's own OAuth flow, starts a local HTTP server on port `1455` to capture the callback, and writes tokens in the exact v2 store format the plugin expects.

### Microsoft interstitials

Outlook login often shows interstitial pages after password entry:

| Page | Handled by |
|------|-----------|
| "Stay signed in?" | Auto-clicks "Yes" |
| "Let's protect your account" | Auto-clicks "Skip for now" |
| FIDO/Passkey creation (`/fido/create`) | Auto-clicks "Not now" / "Cancel" |
| Any other blocker | Force-navigates to inbox |

### Troubleshooting

- **`--visible` mode** shows the browser so you can see exactly where the flow gets stuck.
- **Debug screenshots** are saved as `auto-login/debug_<user>_<step>.png` on failure.
- **SSL errors on macOS**: the script uses `ssl._create_unverified_context()` for token exchange requests. This is safe for local automation.
- **Port 1455 in use**: kill any process using that port, or change `REDIRECT_PORT` in the script.
- **Stale OTP codes**: if the inbox has old verification emails, the script may pick up an expired code. Clear the inbox or wait for a fresh email.

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
