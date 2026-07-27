# Sandbox Quick Ref (Offline)

Use this to manually test without touching your live OpenCode/Codex setup.

## 1) One-time setup (inside required folder)
```bash
cd /Users/jorgitin/Documents/projects/open_multi_auth
git clone https://github.com/floze-the-genius/opencode-multi-auth-codex.git .
npm ci
npm run build
```

If this folder is not empty, clone to a temporary location and copy the repo contents into `/Users/jorgitin/Documents/projects/open_multi_auth` before running tests.

## 2) Isolated sandbox env
```bash
export HOME=/tmp/oma-sandbox-home
export OPENCODE_MULTI_AUTH_STORE_DIR=/tmp/oma-sandbox-store
export OPENCODE_MULTI_AUTH_CODEX_AUTH_FILE=/tmp/oma-sandbox-home/.codex/auth.json

mkdir -p "$HOME/.codex" "$OPENCODE_MULTI_AUTH_STORE_DIR"
```

## 3) Invoke sandbox version (manual testing)
Status:
```bash
node dist/cli.js status
```

Run dashboard locally:
```bash
node dist/cli.js web --host 127.0.0.1 --port 4343
```
Open: `http://127.0.0.1:4343`

## 4) Fast safety checks (must stay sandboxed)
```bash
node dist/cli.js path
echo "$HOME"
echo "$OPENCODE_MULTI_AUTH_STORE_DIR"
echo "$OPENCODE_MULTI_AUTH_CODEX_AUTH_FILE"
```

Expected:
- store path under `/tmp/oma-sandbox-store`
- auth path under `/tmp/oma-sandbox-home/.codex/auth.json`

## 5) Single-command sandbox invocation (no persistent exports)
```bash
HOME=/tmp/oma-sandbox-home \
OPENCODE_MULTI_AUTH_STORE_DIR=/tmp/oma-sandbox-store \
OPENCODE_MULTI_AUTH_CODEX_AUTH_FILE=/tmp/oma-sandbox-home/.codex/auth.json \
node dist/cli.js web --host 127.0.0.1 --port 4343
```

## 6) Quick troubleshooting

`EADDRINUSE` (port busy):
```bash
node dist/cli.js web --host 127.0.0.1 --port 4344
```

Store looks wrong/corrupt:
```bash
ls -la /tmp/oma-sandbox-store
```
Delete only sandbox store:
```bash
rm -rf /tmp/oma-sandbox-store
mkdir -p /tmp/oma-sandbox-store
```

Need clean sandbox reset:
```bash
rm -rf /tmp/oma-sandbox-home /tmp/oma-sandbox-store
mkdir -p /tmp/oma-sandbox-home/.codex /tmp/oma-sandbox-store
```

`spawn codex ENOENT` during limits refresh:
- `codex` binary is missing from PATH in that shell.
- Fix PATH or skip limits-refresh tests in that environment.

Probe run fails with usage-limit/model/config error:
- Expected hardened behavior: account `limitStatus` becomes `error` and prior `rateLimits` remain unchanged.
- Dashboard/API should expose the failure state instead of silently replacing limits with error-session values.

Limits confidence quick check (after feature is implemented):
- Trigger a successful limits refresh and verify account shows `fresh` confidence.
- Trigger a known failing probe and verify:
  - confidence switches to `error`
  - prior limits are preserved
  - `lastLimitErrorAt` updates.

Force mode quick check (after feature is implemented):
- In dashboard, enable "Force this account for 24h" on one alias.
- Send multiple requests and confirm that alias is always selected while eligible.
- Clear force mode and confirm scheduler returns to previous strategy.

Account enable/disable quick check (after feature is implemented):
- Use the account `Enabled` iOS-style switch to turn one alias off and confirm it is never selected.
- Turn the same alias back on and confirm it returns to eligibility.
- Turn off the currently forced alias and confirm force clears immediately and previous strategy is restored.
- Confirm legacy disable button/control is removed from the dashboard (switch is the only disable mechanism).

Re-auth quick check (after feature is implemented):
- Trigger re-auth for one alias from dashboard.
- Confirm only that alias credentials update.
- If that alias is active, confirm auth pointer remains consistent after re-auth.

## 7) Promotion guard reminder
Never point sandbox env vars to real `~/.codex` or real store paths until all validation gates are green.
Dashboard policy for hardened build: localhost-only (no remote dashboard mode).
Use `TEST_EXECUTION_PLAN.md` as the full post-implementation runbook.
