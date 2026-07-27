# OpenCode Multi-Auth Reliability Upgrade Plan

## 1. Objective
Upgrade `guard22/opencode-multi-auth-codex` so it is reliable and low-maintenance for daily use, with strict pre-promotion validation.

Primary goal: multi-account Codex linking + rotation that just works.

## 1.1 Repository Location Requirement
- Repository location for implementation and tests:
  - `/Users/jorgitin/Documents/projects/open_multi_auth`

## 1.2 Baseline and Scope
- Baseline upstream: `https://github.com/floze-the-genius/opencode-multi-auth-codex`
- This work is a hardening/improvement pass on upstream plus custom behavior changes.
- Implement in source TypeScript (`src/*`), tests, and docs. Do not hand-edit `dist/*` for release.

## 1.3 Custom Changes Included
- Account-level re-auth from dashboard/API.
- Account-level iOS-like `Enabled` switch from dashboard/API.
- Remove legacy disable control; `Enabled` switch becomes the disable mechanism.
- Keep force toggle separate from account `Enabled` switch behavior and UI.

## 1.4 Known Live Issues to Permanently Fix
- Limits probe can fail from model/config incompatibility (for example `xhigh` with probe model).
- Failed probe runs may emit `token_count`; those must never overwrite authoritative limits.
- Weekly/five-hour values can look inconsistent if stale/error-derived snapshots are shown as fresh.

## 1.5 Permanent Limits Accuracy Requirements
- Dashboard/API limits must come from the last successful authoritative probe only.
- Failed/incomplete probe runs must not mutate stored `weekly`/`fiveHour` values.
- If latest probe fails, expose error + freshness/confidence state.
- If no successful snapshot exists yet, show `unknown` (never synthetic `0%`).

## 2. Independent Phase Execution Model (for multi-model implementation)
- Each phase below is an independent packet with its own markdown TODOs, verification, and handoff outputs.
- You can execute phases in separate model sessions and with different models.
- Recommended order is `A -> I`, but each phase can be completed and validated independently.
- A phase is considered complete only when its local verification checklist is green.
- If a phase changes shared contracts, rerun affected verification in prior completed phases.

## 3. Locked Decisions
- Core connector reliability is first priority.
- Dashboard is localhost-only (`127.0.0.1` / loopback); no remote dashboard mode.
- Weighted scheduler is opt-in (`weighted-round-robin`).
- Force mode pins one account for 24h and auto-reverts to previous strategy.
- Antigravity remains in codebase but is off by default and hidden unless explicitly enabled.
- Promotion policy: canary -> weighted enablement -> 72h stability watch.
- Rollback trigger: any critical reliability/security incident.

## 4. Shared Contracts (must remain valid across all phases)

## 4.1 Store Contract
- [ ] Store supports versioned schema (`v2`) with deterministic migration from `v1`.
- [ ] Per-account fields include: `enabled`, `disabledAt`, `disabledBy`, `disableReason` (optional).
- [ ] Limits fields include: `rateLimits`, `rateLimitHistory`, `limitStatus`, `limitError`, `lastLimitProbeAt`, `lastLimitErrorAt`.
- [ ] Force fields include: `forcedAlias`, `forcedUntil`, `previousRotationStrategy`, `forcedBy`.

## 4.2 API Contract
- [ ] Mutating endpoints return deterministic typed errors (`code`, `message`, optional `details`).
- [ ] Alias-scoped mutating endpoints must only mutate target alias.
- [ ] `GET /api/accounts` includes eligibility/health/cooldown + limits freshness/confidence metadata.

## 4.3 Limits Data Quality Contract
- [ ] Probe sets compatible reasoning effort explicitly (`low` default, env-overridable).
- [ ] Probe retries/fallback handles `unsupported_value` / `reasoning.effort` failures.
- [ ] Failed/incomplete probe sessions are non-authoritative and cannot overwrite limits.
- [ ] No-authoritative-data state is represented as `unknown`.

## 4.4 Observability Contract
- [ ] Decision logs include `requestId`, `strategy`, `selectedAlias`, `fallbackReason`, `forceState`, `enabledState`.
- [ ] Sensitive token material is redacted in all log paths.

## 5. Independent Phase Packets

## Phase A: Repository Bootstrap + Baseline Capture
### Todos
- [x] Clone upstream repo into `/Users/jorgitin/Documents/projects/open_multi_auth`.
- [x] Install dependencies and build baseline.
- [x] Capture baseline behavior (`status`, `web`, limits refresh, logs).
- [x] Record baseline in `docs/QA.md`.

### Verification (Enhanced)
**L0: Repository Integrity**
- [x] Clone completes without corruption (`git status` clean)
- [x] All tracked files present (`git ls-files | wc -l` matches upstream)
- [x] No uncommitted changes in baseline

**L1: Build Verification**
- [x] `npm ci` completes with zero exit code
- [x] `npm run build` produces `dist/` directory
- [x] `npx tsc --noEmit` passes with zero type errors
- [x] Entry point (`dist/cli.js`) exists and is executable

**L2: Baseline Behavior Capture**
- [x] `node dist/cli.js status` executes without crash
- [x] `node dist/cli.js web --help` shows expected help text
- [x] Dashboard starts on port (manual check: `node dist/cli.js web --port 9999`)
- [x] Baseline limits refresh command executes
- [x] Log files generated in expected location

**L3: Documentation**
- [x] `docs/QA.md` created with baseline metrics
- [x] Baseline command outputs captured
- [x] Known issues from upstream documented

### Handoff Output
- [x] Baseline artifact paths + command results documented.
- [x] Baseline behavior snapshot stored for comparison.
- [x] QA.md baseline section complete.

## Phase B: Core Runtime Reliability Hardening
### Todos
- [x] Replace recursive retries with bounded iterative attempts.
- [x] Enforce per-request max attempts (`<= eligible account count`).
- [x] Add deterministic fail-fast when no eligible account (`NO_ELIGIBLE_ACCOUNTS`).
- [x] Add top-level web route error guard.
- [x] Enforce localhost-only host binding.
- [x] Add store schema validation on load.
- [x] Add store migration framework for version upgrades.
- [x] Add in-process write lock around read-modify-write operations.
- [x] Harden persistence write (`tmp -> fsync(file) -> rename -> fsync(dir)`).
- [x] Add last-known-good snapshot + auto-restore on parse/validation failure.
- [x] Add explicit `OPENCODE_MULTI_AUTH_CODEX_AUTH_FILE` override.
- [x] Add OAuth callback redirect-port fallback behavior.
- [x] Add health hysteresis/cooldown to prevent account flapping.

### Verification (Enhanced)
**L1: Retry & Fail-Fast Unit Tests**
- [x] Unit test: Recursive retry replaced with bounded iteration (max 3 attempts)
- [x] Unit test: Per-request attempts never exceed eligible account count
- [x] Unit test: `NO_ELIGIBLE_ACCOUNTS` error thrown deterministically when no accounts available
- [x] Unit test: Retry counter increments correctly per attempt
- [x] Unit test: Exponential backoff calculation (if implemented)

**L2: Store Reliability Tests**
- [x] Unit test: Schema validation rejects malformed store files
- [x] Unit test: v1 to v2 migration executes deterministically
- [x] Unit test: Migration preserves existing account data
- [x] Unit test: Write lock prevents concurrent read-modify-write corruption
- [x] Unit test: Atomic write sequence (`tmp -> fsync -> rename -> fsync`)
- [x] Crash-recovery test: Interrupt during write, verify auto-restore from last-known-good
- [x] Crash-recovery test: Corrupted store file triggers auto-restore
- [x] Crash-recovery test: Empty store file triggers initialization

**L3: Web & Security Tests**
- [x] Unit test: Localhost-only binding rejects non-loopback hosts
- [x] Integration test: Dashboard binds only to `127.0.0.1`
- [x] Unit test: Top-level error guard catches unhandled route errors
- [x] Integration test: OAuth callback handles port fallback correctly

**L4: Health & Cooldown Tests**
- [x] Unit test: Account health hysteresis prevents rapid flapping
- [x] Unit test: Cooldown period respected after account marked unhealthy
- [x] Integration test: Account transitions through health states correctly

**L5: Environment Override Tests**
- [x] Unit test: `OPENCODE_MULTI_AUTH_CODEX_AUTH_FILE` overrides default path
- [x] Integration test: Custom auth file path loads correctly

### Handoff Output
- [x] Reliability change log + failing case reproductions now passing.
- [x] Test coverage report showing >80% on modified files.
- [x] Crash-recovery evidence documented in QA.md.

## Phase C: Limits Accuracy Permanent Fix
### Todos
- [ ] Probe model compatibility hardening:
  - [ ] pass `-c model_reasoning_effort="low"` in probe exec
  - [ ] allow env override for probe effort
  - [ ] probe model order prefers `gpt-5.3-codex` first
  - [ ] fallback-retry on `unsupported_value` / `reasoning.effort`
- [ ] Probe authority hardening:
  - [ ] accept limits only from successful completed probe sessions
  - [ ] reject failed/incomplete/usage-limit sessions as data sources
  - [ ] preserve prior limits on probe failure
  - [ ] update only error metadata (`limitStatus`, `limitError`, `lastLimitErrorAt`) on failed probe
- [ ] Add freshness/confidence state (`fresh`, `stale`, `error`, `unknown`) to API/UI.
- [ ] Represent missing-authoritative-data as `unknown` (not `0%`).
- [ ] Add probe source diagnostics (model, source session/file, timestamp).

### Verification (Enhanced - Must Pass 100%)
**Pre-Test Setup:**
- [ ] Sandbox environment isolated (`HOME=/tmp/oma-sandbox-limits`, separate auth file)
- [ ] Baseline snapshot captured of existing limits behavior

**L1: Parser Authority Unit Tests**
- [ ] Unit test: Parser accepts only fully successful probe sessions as authoritative
- [ ] Unit test: Parser rejects sessions with `token_count` on error/failure
- [ ] Unit test: Parser rejects incomplete/crashed probe sessions
- [ ] Unit test: Parser correctly identifies `unsupported_value` / `reasoning.effort` errors
- [ ] Unit test: Probe fallback model ordering (`gpt-5.3-codex` prioritized)
- [ ] Unit test: Env override `OPENCODE_MULTI_AUTH_PROBE_EFFORT` takes precedence
- [ ] Unit test: Default probe effort is `low` when not specified

**L2: Limits Mutation Integration Tests**
- [ ] Integration test: Failed probe cannot overwrite prior valid limits
- [ ] Integration test: Probe returning HTTP 200 but with error body does not mutate limits
- [ ] Integration test: Probe with partial `token_count` data on failure preserves prior limits
- [ ] Integration test: Interrupted probe (SIGTERM during exec) leaves limits unchanged
- [ ] Integration test: No successful snapshot exists -> display shows `unknown`
- [ ] Integration test: Successful probe updates limits AND appends to `rateLimitHistory`
- [ ] Integration test: Concurrent probes cannot cause race condition in limits update
- [ ] Integration test: Limits history maintains max 100 entries, FIFO eviction

**L3: Freshness/Confidence State Tests**
- [ ] Unit test: `fresh` state when probe succeeded within last 5 minutes
- [ ] Unit test: `stale` state when probe succeeded 5-60 minutes ago
- [ ] Unit test: `error` state when last probe failed and < 60 min since success
- [ ] Unit test: `unknown` state when no successful probe ever OR last success > 60 min
- [ ] API test: `GET /api/accounts` includes `limitsConfidence` field with correct enum
- [ ] API test: `GET /api/accounts` includes `lastLimitProbeAt` ISO timestamp
- [ ] API test: `GET /api/accounts` includes `limitStatus` field

**L4: Model Compatibility & Error Handling**
- [ ] Integration test: `xhigh` reasoning config does not break probe execution
- [ ] Integration test: `unsupported_value` error triggers retry with `low` effort
- [ ] Integration test: All retry attempts exhausted -> probe marked failed, limits preserved
- [ ] Integration test: Probe diagnostics include model name, timestamp, source log file

**L5: Display Accuracy Tests**
- [ ] Headless UI test: Account with no data shows "unknown" (not "0%")
- [ ] Headless UI test: Stale limits show visual indicator (badge/color change)
- [ ] Headless UI test: Error state shows error icon + tooltip with last error
- [ ] Headless UI test: Weekly/five-hour percentages reflect actual authoritative data

**L6: Regression Prevention**
- [ ] Test: Simulate old bug - probe with `token_count` on failure -> verify limits unchanged
- [ ] Test: Weekly and five-hour values never appear inconsistent after probe failure
- [ ] Test: Rapid successive probe failures don't corrupt stored limit history

**L7: Contract Verification**
- [ ] Verify `Limits Data Quality Contract` (Section 4.3) all items pass
- [ ] Verify `Permanent Limits Accuracy Requirements` (Section 1.5) all items pass

### Handoff Output
- [ ] Before/after evidence for weekly/five-hour consistency behavior.
- [ ] Test execution log with all 25+ test cases passing.
- [ ] QA entry in `docs/QA.md` with specific test commands and results.

## Phase D: Account Lifecycle Controls (Enabled Switch + Re-auth)
### Todos
- [ ] Add persisted account availability fields (`enabled`, `disabledAt`, `disabledBy`, `disableReason`).
- [ ] Exclude disabled accounts from all eligibility checks.
- [ ] Add APIs:
  - [ ] `GET /api/accounts`
  - [ ] `PUT /api/accounts/:alias/enabled`
  - [ ] `POST /api/accounts/:alias/reauth`
- [ ] Dashboard controls:
  - [ ] iOS-like `Enabled` switch per account with states `off|on|updating|error`
  - [ ] `Re-auth` action per account with states `idle|in-progress|success|error`
  - [ ] disable toggle while request is in flight (double-submit safe)
- [ ] Remove legacy disable button/control from dashboard.
- [ ] Ensure `Enabled` switch is the only disable mechanism.
- [ ] Re-auth contract: only targeted alias credentials mutate.

### Verification (Enhanced - DO NOT START PHASE D UNTIL ALL PASS)
**Pre-Test Setup:**
- [ ] Sandbox environment isolated (`HOME=/tmp/oma-sandbox-accounts`, separate auth file)
- [ ] Minimum 2 test accounts configured
- [ ] Legacy disable control removed and verified absent

**L1: Store & Persistence Tests**
- [ ] Unit test: `enabled` field persists and survives restart
- [ ] Unit test: `disabledAt` timestamp set on disable
- [ ] Unit test: `disabledBy` captures actor identity
- [ ] Unit test: `disableReason` optional field stores correctly
- [ ] Unit test: Disabled accounts excluded from rotation eligibility
- [ ] Unit test: Schema validation accepts new account fields
- [ ] Integration test: Disable one account, verify other accounts still rotate
- [ ] Persistence test: Restart process, verify disabled state preserved

**L2: Enable/Disable API Tests**
- [ ] API test: `PUT /api/accounts/:alias/enabled` with `true` enables account
- [ ] API test: `PUT /api/accounts/:alias/enabled` with `false` disables account
- [ ] API test: Disable returns deterministic error for unknown alias (404)
- [ ] API test: Disable returns deterministic error for already disabled alias (409)
- [ ] API test: Toggle response includes updated account state
- [ ] API test: `GET /api/accounts` includes `enabled` field for all accounts
- [ ] API test: `GET /api/accounts` includes eligibility metadata
- [ ] API test: Double-submit protection (concurrent toggles rejected)

**L3: Re-auth API Tests**
- [ ] API test: `POST /api/accounts/:alias/reauth` targets only specified alias
- [ ] API test: Re-auth does not mutate other account credentials
- [ ] API test: Re-auth returns deterministic error for unknown alias
- [ ] API test: Re-auth returns deterministic error for disabled alias
- [ ] API test: Active alias re-auth maintains active auth pointer consistency
- [ ] API test: Re-auth progress state transitions correctly
- [ ] API test: Re-auth success updates credentials and metadata
- [ ] API test: Re-auth failure preserves previous credentials (no partial update)

**L4: Dashboard UI Tests (Headless)**
- [ ] UI test: Accounts table renders all aliases with `Enabled` switch
- [ ] UI test: Switch state `off` displays correctly for disabled accounts
- [ ] UI test: Switch state `on` displays correctly for enabled accounts
- [ ] UI test: Switch state `updating` displays during toggle in-flight
- [ ] UI test: Switch state `error` displays on toggle failure
- [ ] UI test: Double-click prevention (switch disabled during request)
- [ ] UI test: Toggle persists across page reload
- [ ] UI test: Legacy disable button/control is completely absent
- [ ] UI test: Re-auth button shows `idle` state initially
- [ ] UI test: Re-auth button shows `in-progress` during re-auth
- [ ] UI test: Re-auth button shows `success` on completion
- [ ] UI test: Re-auth button shows `error` on failure
- [ ] UI test: `Enabled` switch is the ONLY disable mechanism in UI

**L5: Eligibility & Rotation Tests**
- [ ] Integration test: Disabled account never selected by rotation
- [ ] Integration test: Rotation skips disabled accounts in round-robin
- [ ] Integration test: All accounts disabled -> `NO_ELIGIBLE_ACCOUNTS` error
- [ ] Integration test: Re-enabled account becomes eligible immediately
- [ ] Integration test: Health checks respect disabled state (no health checks for disabled)

**L6: Contract Verification**
- [ ] Verify `Store Contract` Section 4.1 per-account fields pass
- [ ] Verify `API Contract` Section 4.2 alias-scoped mutation passes
- [ ] Verify Section 1.3 custom changes (Enabled switch only disable mechanism) pass

**L7: Security & Edge Cases**
- [ ] Security test: Cannot disable last enabled account (prevent lockout)
- [ ] Security test: API rejects enable/disable for non-existent accounts
- [ ] Edge case: Rapid enable/disable toggles maintain consistency
- [ ] Edge case: Re-auth during active request handled gracefully

### Handoff Output
- [ ] Screenshots/test artifacts for account controls.
- [ ] Test execution log with all 35+ test cases passing.
- [ ] QA entry in `docs/QA.md` with specific test commands and results.
- [ ] Evidence that legacy disable control is removed.

## Phase E: Force Mode (Separate from Enabled Switch)
### Todos
- [ ] Persist force state (`forcedAlias`, `forcedUntil`, `previousRotationStrategy`, `forcedBy`).
- [ ] Force behavior:
  - [ ] active + eligible forced alias always selected
  - [ ] forced alias ineligible -> immediate clear + restore previous strategy
  - [ ] forced alias manually disabled -> immediate clear + restore previous strategy
  - [ ] forced alias removed -> auto-clear + restore
  - [ ] expiry -> clear + restore
  - [ ] TTL anchored to first activation (no extension on re-toggle)
- [ ] Force API:
  - [ ] `GET /api/force`
  - [ ] `POST /api/force`
  - [ ] `POST /api/force/clear`
- [ ] Force dashboard toggle (iOS-like) with states `off|on|updating|error`.
- [ ] Keep force toggle visually/behaviorally separate from account `Enabled` switches.

### Verification (Enhanced)
**Pre-Test Setup:**
- [ ] Sandbox environment isolated
- [ ] Minimum 3 test accounts configured
- [ ] Force toggle visually distinct from account `Enabled` switches

**L1: Force State Persistence Tests**
- [ ] Unit test: `forcedAlias` persists and survives restart
- [ ] Unit test: `forcedUntil` TTL calculated correctly (24h from activation)
- [ ] Unit test: `previousRotationStrategy` stored correctly
- [ ] Unit test: `forcedBy` captures actor identity
- [ ] Integration test: Restart process, verify force state preserved

**L2: Force Selection Logic Tests**
- [ ] Unit test: Active + eligible forced alias always selected
- [ ] Unit test: Forced alias ineligible -> immediate clear + restore strategy
- [ ] Unit test: Forced alias disabled -> immediate clear + restore strategy
- [ ] Unit test: Forced alias removed -> auto-clear + restore
- [ ] Unit test: Expired force (`forcedUntil` passed) -> clear + restore
- [ ] Unit test: TTL does NOT extend on re-toggle within 24h
- [ ] Unit test: Force cleared on new force activation (different alias)

**L3: Force API Tests**
- [ ] API test: `GET /api/force` returns current force state
- [ ] API test: `POST /api/force` with alias activates force mode
- [ ] API test: Force activation requires existing, enabled alias
- [ ] API test: Force activation stores `forcedUntil` timestamp
- [ ] API test: Force activation stores `previousRotationStrategy`
- [ ] API test: `POST /api/force/clear` deactivates force and restores strategy
- [ ] API test: Clear returns current strategy after restoration
- [ ] API test: API returns deterministic errors for invalid operations

**L4: Force Dashboard UI Tests (Headless)**
- [ ] UI test: Force toggle visually/behaviorally separate from account switches
- [ ] UI test: Force toggle state `off` when no force active
- [ ] UI test: Force toggle state `on` when force active
- [ ] UI test: Force toggle state `updating` during activation/clear
- [ ] UI test: Force toggle state `error` on operation failure
- [ ] UI test: Force toggle shows forced alias name when active
- [ ] UI test: Force toggle shows remaining TTL when active
- [ ] UI test: Expired force automatically shows `off` state

**L5: Integration & Rotation Tests**
- [ ] Integration test: Rotation selects forced alias when active and eligible
- [ ] Integration test: Rotation returns to previous strategy after force cleared
- [ ] Integration test: Force survives across multiple requests
- [ ] Integration test: Decision logs include `forceState` field

**L6: Contract Verification**
- [ ] Verify `Store Contract` Section 4.1 force fields pass
- [ ] Verify `Observability Contract` Section 4.4 decision logs include force state
- [ ] Verify Section 1.3 (force toggle separate from Enabled switch) passes

**L7: Edge Cases & Lifecycle**
- [ ] Edge case: Force activated when no accounts exist
- [ ] Edge case: Force activated with expired TTL
- [ ] Edge case: Force cleared when no force active
- [ ] Lifecycle test: Complete force lifecycle observed (activate -> use -> expire)
- [ ] Lifecycle test: Force survives 48h soak (Phase H requirement)

### Handoff Output
- [ ] Force lifecycle evidence including expiry/clear paths.
- [ ] Test execution log with all 30+ test cases passing.
- [ ] QA entry in `docs/QA.md` with specific test commands and results.

## Phase F: Settings + Weighted Rotation
### Todos
- [ ] Add persisted settings model.
- [ ] Implement precedence: defaults -> persisted -> runtime config -> env.
- [ ] Implement `weighted-round-robin` strategy.
- [ ] Add weighted presets: Balanced, Conservative, Aggressive.
- [ ] Add advanced validation:
  - [ ] thresholds in `0..100`
  - [ ] `critical < low`
  - [ ] weights in `(0,1]`
  - [ ] minimum weight constraints
- [ ] Add settings API (`GET/PUT/reset`) and settings panel UI.

### Verification (Enhanced)
**Pre-Test Setup:**
- [ ] Sandbox environment isolated
- [ ] Minimum 3 test accounts with varying weights

**L1: Settings Persistence Tests**
- [ ] Unit test: Settings model persists and survives restart
- [ ] Unit test: Settings precedence: defaults -> persisted -> runtime -> env
- [ ] Unit test: Environment variables override persisted settings
- [ ] Unit test: Runtime config overrides persisted but not env
- [ ] Integration test: Restart process, verify settings preserved

**L2: Settings Validation Tests**
- [ ] Unit test: Threshold must be in range `0..100`
- [ ] Unit test: `critical` threshold must be `< low` threshold
- [ ] Unit test: Weight must be in range `(0,1]`
- [ ] Unit test: Minimum weight constraints enforced
- [ ] Unit test: Invalid settings rejected with deterministic error
- [ ] API test: `PUT /api/settings` validates input and rejects invalid
- [ ] API test: Validation errors include specific field and constraint

**L3: Weighted Rotation Tests**
- [ ] Unit test: Weighted distribution respects account weights
- [ ] Unit test: Higher weight accounts selected more frequently
- [ ] Unit test: All eligible accounts receive some traffic (no starvation)
- [ ] Unit test: Weighted calculation with 2+ accounts
- [ ] Unit test: Weighted calculation with 5+ accounts
- [ ] Integration test: Run 1000 rotations, verify distribution matches weights
- [ ] Integration test: Round-robin remains default unless explicitly changed

**L4: Presets Tests**
- [ ] Unit test: Balanced preset applies equal weights
- [ ] Unit test: Conservative preset applies lower thresholds
- [ ] Unit test: Aggressive preset applies higher thresholds
- [ ] API test: Preset application validates and applies settings
- [ ] UI test: Preset selection updates settings correctly

**L5: Settings API Tests**
- [ ] API test: `GET /api/settings` returns current settings
- [ ] API test: `PUT /api/settings` updates settings atomically
- [ ] API test: Settings update validates all constraints
- [ ] API test: `POST /api/settings/reset` restores defaults
- [ ] API test: Reset clears persisted settings
- [ ] API test: Settings changes logged to audit log

**L6: Dashboard Settings Panel Tests (Headless)**
- [ ] UI test: Settings panel renders with current values
- [ ] UI test: Threshold inputs validate range `0..100`
- [ ] UI test: Weight inputs validate range `(0,1]`
- [ ] UI test: `critical < low` constraint enforced in UI
- [ ] UI test: Save button applies settings and shows success
- [ ] UI test: Reset button restores defaults with confirmation
- [ ] UI test: Validation errors displayed inline
- [ ] UI test: Settings persist across page reload

**L7: Contract Verification**
- [ ] Verify round-robin remains default strategy
- [ ] Verify weighted strategy is opt-in only
- [ ] Verify settings precedence chain works correctly

**L8: Edge Cases**
- [ ] Edge case: All weights equal -> uniform distribution
- [ ] Edge case: One account weight = 1.0, others minimal -> heavy skew
- [ ] Edge case: Settings update during active rotation handled gracefully

### Handoff Output
- [ ] Weighted strategy behavior report with sample distributions.
- [ ] Test execution log with all 35+ test cases passing.
- [ ] QA entry in `docs/QA.md` with specific test commands and results.

## Phase G: Non-Core Isolation
### Todos
- [ ] Gate antigravity functionality behind feature flag (default off).
- [ ] Hide antigravity UI/panel unless enabled.
- [ ] Ensure non-core paths cannot affect core rotation by default.

### Verification (Enhanced)
**Pre-Test Setup:**
- [ ] Sandbox environment isolated
- [ ] Feature flag system implemented

**L1: Feature Flag Unit Tests**
- [ ] Unit test: Antigravity feature flag defaults to `false`
- [ ] Unit test: Flag can be enabled via environment variable
- [ ] Unit test: Flag can be enabled via settings API
- [ ] Unit test: Flag change persists across restart

**L2: Flag-Off Behavior Tests**
- [ ] Integration test: Core rotation works normally with flag off
- [ ] Integration test: No antigravity side effects on rotation decisions
- [ ] Integration test: No antigravity side effects on account selection
- [ ] Integration test: Store operations unaffected by antigravity code paths
- [ ] Integration test: Logs contain no antigravity-related entries when flag off

**L3: Flag-On Behavior Tests**
- [ ] Integration test: Antigravity feature reachable when flag enabled
- [ ] Integration test: Antigravity UI/panel visible when flag enabled
- [ ] Integration test: Core rotation still works correctly with flag on
- [ ] Integration test: Account selection respects antigravity rules when enabled
- [ ] Integration test: No core regression when antigravity active

**L4: UI Isolation Tests (Headless)**
- [ ] UI test: Antigravity panel absent when flag off
- [ ] UI test: Antigravity controls absent when flag off
- [ ] UI test: Antigravity panel present when flag on
- [ ] UI test: Flag toggle in settings works correctly
- [ ] UI test: No visual leakage of antigravity when flag off

**L5: Security & Isolation Tests**
- [ ] Security test: Antigravity cannot modify core rotation when flag off
- [ ] Security test: Antigravity cannot access sensitive data when flag off
- [ ] Security test: Flag change requires appropriate permissions

**L6: Contract Verification**
- [ ] Verify Section 3 Locked Decisions (antigravity off by default)
- [ ] Verify non-core paths do not affect core rotation by default

**L7: Edge Cases**
- [ ] Edge case: Flag toggled during active request
- [ ] Edge case: Flag enabled then disabled, verify clean state

### Handoff Output
- [ ] Feature-flag behavior matrix.
- [ ] Test execution log with all 20+ test cases passing.
- [ ] QA entry in `docs/QA.md` with specific test commands and results.

## Phase H: Full Validation Matrix (Reliability + Security)
### Todos
- [ ] L0 Build/Type gates:
  - [ ] `npm ci`
  - [ ] `npm run lint` (if script exists; otherwise document N/A)
  - [ ] `npm run build`
  - [ ] `npx tsc --noEmit`
- [ ] L1 Unit coverage:
  - [ ] rotation math/fairness
  - [ ] retry bounds
  - [ ] store migration/validation
  - [ ] account enable/disable
  - [ ] re-auth alias scope
  - [ ] force lifecycle rules
  - [ ] limits compatibility + integrity + `unknown`
- [ ] L2 Sandbox integration:
  - [ ] isolated HOME/store/auth paths only
  - [ ] account switch/re-auth/force workflows
  - [ ] freshness/confidence behavior
- [ ] L3 Failure injection:
  - [ ] 401/403 auth failures
  - [ ] 429 rate limits
  - [ ] 402 deactivated workspace
  - [ ] 400 model unsupported
  - [ ] probe session with token_count + final failure does not overwrite limits
- [ ] L4 Concurrency/stress:
  - [ ] parallel bursts with no lost updates
  - [ ] store remains consistent
- [ ] L5 Security/exposure:
  - [ ] reject non-loopback bind
  - [ ] deterministic errors for unknown/disabled alias mutations
  - [ ] redaction in logs verified
- [ ] L6 Soak gate:
  - [ ] 48h sandbox soak with periodic traffic
  - [ ] no crashes, no stuck rotation, no corruption
  - [ ] at least one full force lifecycle observed
- [ ] L7 Observability + SLO:
  - [ ] required decision log schema present
  - [ ] success rate >= 99.9%
  - [ ] unhandled exceptions = 0
  - [ ] p95 latency regression <= 10%
  - [ ] failed probes never mutate limits

### Verification
- [ ] Run `TEST_EXECUTION_PLAN.md` end-to-end with artifacts.
- [ ] Repeat integration + headless runs 5 times to detect flakes.

### Handoff Output
- [ ] Complete QA evidence in `docs/QA.md`.

## Phase I: Docs, Promotion, and Rollback Readiness
### Todos
- [ ] Rewrite `README.md` (simple install/use).
- [ ] Update `docs/TESTING.md` with exact commands.
- [ ] Update `docs/OFFLINE_RECOVERY.md`.
- [ ] Update `docs/QA.md` troubleshooting matrix.
- [ ] Keep `TEST_EXECUTION_PLAN.md` current with scripts and gate order.
- [ ] Promotion steps:
  - [ ] capture baseline metrics
  - [ ] 24h canary on round-robin
  - [ ] weighted enablement
  - [ ] 72h stability watch
- [ ] Rollback drill:
  - [ ] revert to last known-good
  - [ ] restore settings snapshot
  - [ ] verify `list/status/switch/refresh`

### Verification (Enhanced)
**L1: Documentation Completeness**
- [ ] Doc review: `README.md` includes simple install/use instructions
- [ ] Doc review: `README.md` includes quickstart example
- [ ] Doc review: `docs/TESTING.md` lists all exact test commands
- [ ] Doc review: `docs/TESTING.md` explains test execution order
- [ ] Doc review: `docs/OFFLINE_RECOVERY.md` covers store corruption recovery
- [ ] Doc review: `docs/OFFLINE_RECOVERY.md` covers auth file recovery
- [ ] Doc review: `docs/QA.md` includes troubleshooting matrix
- [ ] Doc review: `docs/QA.md` includes all test execution results
- [ ] Doc review: `TEST_EXECUTION_PLAN.md` matches actual test scripts

**L2: Script Availability Verification**
- [ ] Verify: `npm run lint` script exists and runs
- [ ] Verify: `npm run build` script exists and runs
- [ ] Verify: `npm run test:unit` script exists and runs
- [ ] Verify: `npm run test:integration` script exists and runs
- [ ] Verify: `npm run test:web:headless` script exists and runs
- [ ] Verify: `npm run test:failure` script exists and runs
- [ ] Verify: `npm run test:stress` script exists and runs
- [ ] Verify: `npm run test:sandbox` script exists and runs
- [ ] Verify: `npm run test:soak:48h` script exists and runs

**L3: Canary Testing**
- [ ] Canary: 24h canary test started on round-robin strategy
- [ ] Canary: Metrics captured (success rate, latency, rotation distribution)
- [ ] Canary: Weighted strategy enablement test
- [ ] Canary: 72h stability watch initiated
- [ ] Canary: No critical errors during canary period
- [ ] Canary: Performance regression < 10%

**L4: Rollback Drill**
- [ ] Rollback: Revert to last known-good version documented
- [ ] Rollback: Settings snapshot restore procedure tested
- [ ] Rollback: `list` command works after rollback
- [ ] Rollback: `status` command works after rollback
- [ ] Rollback: `switch` command works after rollback
- [ ] Rollback: `refresh` command works after rollback
- [ ] Rollback: Rollback completes within 5 minutes
- [ ] Rollback: Zero data loss during rollback

**L5: Acceptance Criteria Verification**
- [ ] Verify: Every required phase packet is complete (A-I)
- [ ] Verify: Shared contracts (Section 4) remain valid
- [ ] Verify: Full validation matrix (Phase H) is green
- [ ] Verify: Permanent limits accuracy requirements met
- [ ] Verify: Account lifecycle controls complete
- [ ] Verify: Promotion and rollback readiness complete

**L6: Final QA Evidence**
- [ ] Complete QA evidence collected in `docs/QA.md`
- [ ] All test execution logs archived
- [ ] All handoff outputs from phases A-I present
- [ ] Phase H: 5 consecutive integration runs all pass
- [ ] Phase H: 5 consecutive headless runs all pass
- [ ] Phase H: Stress test shows no lost updates
- [ ] Phase H: Soak test 48h completed successfully

**L7: Release Readiness**
- [ ] Security review complete (no exposed credentials)
- [ ] Performance SLOs met (Section 3.7)
- [ ] Rollback procedure documented and tested
- [ ] Monitoring and alerting configured
- [ ] Team trained on new features

### Handoff Output
- [ ] Release-readiness checklist signed off.
- [ ] Final QA evidence package in `docs/QA.md`.
- [ ] Test execution summary with all phases passing.
- [ ] Rollback procedure documented.
- [ ] Promotion metrics documented.

## 6. Cross-Phase Handoff Template (use at end of every phase)
- [ ] Phase ID + date/time
- [ ] Files changed
- [ ] Commands run + pass/fail
- [ ] Known limitations/deferred items
- [ ] Risks introduced (if any)
- [ ] Next-phase recommendations

## 7. Final Acceptance Criteria
- [ ] Every required phase packet is complete.
- [ ] Shared contracts (Section 4) remain valid.
- [ ] Full validation matrix (Phase H) is green.
- [ ] Permanent limits accuracy requirements are met (`unknown` + failed-probe-safe behavior).
- [ ] Account lifecycle controls are complete (`Enabled` switch replaces legacy disable; force remains separate).
- [ ] Promotion and rollback readiness complete.

## 8. Suggested File Touch Map
- `src/index.ts`
- `src/rotation.ts`
- `src/store.ts`
- `src/types.ts`
- `src/web.ts`
- `src/auth.ts`
- `src/codex-auth.ts`
- `src/logger.ts`
- `test/` (unit + integration + stress + recovery + headless)
- `README.md`
- `docs/TESTING.md`
- `docs/OFFLINE_RECOVERY.md`
- `docs/QA.md`
- `TEST_EXECUTION_PLAN.md`
