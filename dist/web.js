import * as fs from 'node:fs';
import * as http from 'node:http';
import * as https from 'node:https';
import * as os from 'node:os';
import * as path from 'node:path';
import { URL } from 'node:url';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { createAuthorizationFlow, loginAccount, refreshToken, validateAuthorizationCallback } from './auth.js';
import { getCodexAuthPath, getCodexAuthStatus, getCodexAuthSummary, resolveAliasForCurrentAuth, syncCodexAuthFile, writeCodexAuthForAlias } from './codex-auth.js';
import { getStoreStatus, listAccounts, loadStore, removeAccount, updateAccount } from './store.js';
import { getRefreshQueueState, startRefreshQueue, stopRefreshQueue } from './refresh-queue.js';
import { getLogPath, logError, logInfo, readLogTail } from './logger.js';
import { getForceState, activateForce, clearForce, isForceActive, getRemainingForceTimeMs, formatForceDuration } from './force-mode.js';
import { getSettings, getRuntimeSettings, isFeatureEnabled } from './settings.js';
import { Errors } from './errors.js';
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 3434;
const LOCALHOST_HOST_PATTERN = /^(127\.0\.0\.1|::1|localhost)$/i;
const ALLOW_REMOTE_HOST_ENV = 'OPENCODE_MULTI_AUTH_ALLOW_REMOTE_HOST';
const SYNC_INTERVAL_MS = 3000;
const SYNC_DEBOUNCE_MS = 600;
const ANTIGRAVITY_ACCOUNTS_FILE = path.join(os.homedir(), '.config', 'opencode', 'antigravity-accounts.json');
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
export function isLocalhostHost(host) {
    return LOCALHOST_HOST_PATTERN.test(host.trim());
}
export function isWebHostAllowed(host) {
    return isLocalhostHost(host) || process.env[ALLOW_REMOTE_HOST_ENV] === '1';
}
const execAsync = promisify(exec);
let lastSyncAt = 0;
let lastSyncError = null;
let lastSyncAlias = null;
let syncTimer = null;
let pendingLogin = null;
let pendingManualCallback = null;
let lastLoginError = null;
let antigravityQuotaState = { status: 'idle', scope: 'active' };
let antigravityQuotaInFlight = null;
const HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Codex Token Dashboard</title>
    <style>
      @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;600;700&family=JetBrains+Mono:wght@400;600&display=swap');

      :root {
        --bg: #101419;
        --panel: #171c23;
        --panel-2: #1d232c;
        --panel-3: #252d38;
        --accent: #ffb547;
        --accent-2: #6ee7ff;
        --text: #eef2f7;
        --muted: #97a2b0;
        --danger: #ff6b6b;
        --success: #37d399;
        --warning: #f97316;
        --border-soft: rgba(255,255,255,0.08);
        --border-strong: rgba(255,255,255,0.14);
        --shadow: rgba(0, 0, 0, 0.2);
      }

      * {
        box-sizing: border-box;
        scrollbar-width: none;
        -ms-overflow-style: none;
      }
      *::-webkit-scrollbar {
        width: 0;
        height: 0;
      }
      body {
        margin: 0;
        font-family: 'Space Grotesk', sans-serif;
        background: var(--bg);
        color: var(--text);
        min-height: 100vh;
        line-height: 1.45;
      }
      header {
        padding: 28px 28px 10px;
        display: flex;
        justify-content: center;
      }
      .header-bar {
        width: min(1320px, 100%);
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 18px;
      }
      .header-copy {
        display: grid;
        gap: 6px;
        text-align: left;
      }
      .header-kicker {
        color: var(--accent-2);
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.18em;
        text-transform: uppercase;
      }
      .header-subtitle {
        color: var(--muted);
        max-width: 700px;
      }
      h1 {
        margin: 0;
        font-size: 28px;
        font-weight: 700;
        letter-spacing: -0.02em;
      }
      .container {
        padding: 0 24px 40px;
        display: grid;
        gap: 18px;
      }
      .panel {
        background: var(--panel);
        border: 1px solid var(--border-soft);
        border-radius: 18px;
        box-shadow: 0 8px 24px var(--shadow);
        padding: 18px;
      }
      .meta {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        gap: 14px;
      }
      .meta-item {
        background: var(--panel-2);
        border: 1px solid var(--border-soft);
        border-radius: 14px;
        padding: 12px 14px;
      }
      .meta-item span {
        display: block;
        color: var(--muted);
        font-size: 12px;
      }
      .meta-item strong {
        display: block;
        margin-top: 6px;
        font-size: 16px;
        word-break: break-word;
      }
      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        align-items: center;
      }
      .add-row {
        display: flex;
        gap: 12px;
        margin-top: 12px;
      }
      .add-row input {
        flex: 1;
        background: var(--panel-2);
        border: 1px solid var(--border-soft);
        border-radius: 12px;
        padding: 12px 14px;
        color: var(--text);
        font-family: inherit;
        font-size: 14px;
      }
      .add-row select {
        flex: 1;
        background: var(--panel-2);
        border: 1px solid var(--border-soft);
        border-radius: 12px;
        padding: 12px 14px;
        color: var(--text);
        font-family: inherit;
        font-size: 14px;
      }
      .add-row input::placeholder {
        color: var(--muted);
      }
      .add-row button {
        white-space: nowrap;
      }
      button {
        cursor: pointer;
        border: 1px solid transparent;
        border-radius: 10px;
        padding: 10px 14px;
        font-weight: 600;
        font-family: 'Space Grotesk', sans-serif;
        color: #0b0f14;
        background: var(--accent);
        transition: transform 120ms ease, background-color 120ms ease, border-color 120ms ease;
      }
      button.secondary {
        background: var(--panel-2);
        color: var(--text);
        border: 1px solid var(--border-soft);
      }
      button.ghost {
        background: var(--panel-2);
        color: var(--muted);
        border: 1px solid var(--border-soft);
      }
      button.danger {
        background: var(--danger);
        color: #0b0f14;
      }
      button.small {
        padding: 6px 10px;
        font-size: 12px;
      }
      button:hover {
        border-color: var(--border-strong);
      }
      button:active { transform: translateY(1px); }
      button:disabled,
      input:disabled,
      select:disabled,
      textarea:disabled {
        opacity: 0.55;
        cursor: not-allowed;
      }
      .filters {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        gap: 12px;
      }
      .filters input,
      .filters select {
        width: 100%;
        padding: 10px 12px;
        border-radius: 10px;
        border: 1px solid var(--border-soft);
        background: var(--panel-2);
        color: var(--text);
        font-family: 'Space Grotesk', sans-serif;
      }
      .queue {
        display: grid;
        gap: 10px;
        margin-top: 12px;
      }
      .progress-bar {
        width: 100%;
        height: 8px;
        border-radius: 999px;
        background: rgba(255,255,255,0.06);
        overflow: hidden;
      }
      .progress-fill {
        height: 100%;
        border-radius: 999px;
        background: var(--accent);
        width: 0%;
        transition: width 160ms ease;
      }
      .accounts {
        display: grid;
        gap: 16px;
        grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
      }
      .account-card {
        background: var(--panel);
        border-radius: 16px;
        padding: 16px;
        border: 1px solid var(--border-soft);
        box-shadow: 0 6px 18px rgba(0, 0, 0, 0.12);
        display: flex;
        flex-direction: column;
        gap: 12px;
        height: 100%;
      }
      .account-title {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 8px;
        min-height: 74px;
      }
      .account-heading {
        min-width: 0;
        display: grid;
        gap: 4px;
        align-content: start;
      }
      .account-name {
        font-size: 18px;
        font-weight: 600;
        line-height: 1.2;
        word-break: break-word;
      }
      .account-subtitle {
        color: var(--muted);
        font-size: 12px;
        line-height: 1.35;
        word-break: break-word;
      }
      .account-badges {
        min-width: 94px;
        min-height: 64px;
        display: grid;
        gap: 6px;
        justify-items: end;
        align-content: start;
      }
      .badge {
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        padding: 4px 8px;
        border-radius: 999px;
        background: rgba(55, 211, 153, 0.15);
        color: var(--success);
      }
      .badge.inactive {
        background: rgba(255,255,255,0.08);
        color: var(--muted);
      }
      .badge.recommended {
        background: rgba(110, 231, 255, 0.15);
        color: var(--accent-2);
      }
      .status-badge {
        font-size: 11px;
        padding: 4px 8px;
        border-radius: 999px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }
      .status-idle { background: rgba(255,255,255,0.08); color: var(--muted); }
      .status-queued { background: rgba(110, 231, 255, 0.15); color: var(--accent-2); }
      .status-running { background: rgba(255, 181, 71, 0.2); color: var(--accent); }
      .status-success { background: rgba(55, 211, 153, 0.15); color: var(--success); }
      .status-error { background: rgba(255, 107, 107, 0.18); color: var(--danger); }
      .status-stopped { background: rgba(249, 115, 22, 0.2); color: var(--warning); }
      /* Phase C: Confidence badge styles */
      .confidence-badge {
        font-size: 9px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        padding: 2px 6px;
        border-radius: 6px;
        font-weight: 700;
        margin-left: 6px;
      }
      .confidence-fresh { background: rgba(55, 211, 153, 0.15); color: var(--success); }
      .confidence-stale { background: rgba(255, 181, 71, 0.2); color: var(--accent); }
      .confidence-error { background: rgba(255, 107, 107, 0.18); color: var(--danger); }
      .confidence-unknown { background: rgba(255,255,255,0.08); color: var(--muted); }
      
      /* Phase D: iOS-style toggle switch */
      .toggle-switch {
        position: relative;
        display: inline-flex;
        align-items: center;
        gap: 8px;
        cursor: pointer;
      }
      .toggle-switch input {
        opacity: 0;
        width: 0;
        height: 0;
      }
      .toggle-slider {
        position: relative;
        width: 44px;
        height: 24px;
        background: rgba(255,255,255,0.12);
        border-radius: 24px;
        transition: background 0.2s;
      }
      .toggle-slider:before {
        content: '';
        position: absolute;
        height: 20px;
        width: 20px;
        left: 2px;
        bottom: 2px;
        background: white;
        border-radius: 50%;
        transition: transform 0.2s;
      }
      .toggle-switch input:checked + .toggle-slider {
        background: var(--success);
      }
      .toggle-switch input:checked + .toggle-slider:before {
        transform: translateX(20px);
      }
      .toggle-switch input:disabled + .toggle-slider {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .toggle-switch.updating .toggle-slider {
        background: var(--accent);
        animation: pulse 1s infinite;
      }
      .toggle-switch.error .toggle-slider {
        background: var(--danger);
      }
      @keyframes pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.5; }
      }
      .toggle-label {
        font-size: 13px;
        color: var(--text);
        font-weight: 500;
      }
      .account-controls {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        align-items: center;
        padding: 12px 0;
        border-top: 1px solid var(--border-soft);
        border-bottom: 1px solid var(--border-soft);
      }
      .account-meta {
        display: grid;
        gap: 6px;
        font-size: 13px;
        color: var(--muted);
        min-height: 110px;
        align-content: start;
      }
      .limit-grid {
        display: grid;
        gap: 8px;
      }
      .limit-card {
        background: var(--panel-2);
        border: 1px solid var(--border-soft);
        border-radius: 12px;
        padding: 10px 12px;
        font-size: 13px;
        min-height: 138px;
        display: flex;
        flex-direction: column;
        justify-content: space-between;
      }
      .limit-card strong {
        display: block;
        font-size: 14px;
        color: var(--text);
      }
      .limit-card span {
        color: var(--muted);
        font-size: 12px;
      }
      .limit-card .sparkline {
        margin-top: 6px;
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .sparkline svg {
        width: 110px;
        height: 28px;
      }
      .sparkline .trend {
        font-size: 11px;
        color: var(--muted);
      }
      .tag-row {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        align-items: center;
        min-height: 32px;
      }
      .tag-chip {
        padding: 4px 8px;
        border-radius: 999px;
        background: var(--panel-3);
        font-size: 11px;
        color: var(--muted);
      }
      .notes {
        font-size: 12px;
        color: var(--muted);
        background: var(--panel-2);
        border: 1px solid var(--border-soft);
        padding: 8px 10px;
        border-radius: 10px;
        min-height: 46px;
        display: flex;
        align-items: center;
      }
      .card-footer {
        margin-top: auto;
        display: grid;
        gap: 12px;
      }
      .meta-editor {
        display: none;
        flex-direction: column;
        gap: 8px;
      }
      .meta-editor.show { display: flex; }
      .meta-editor input,
      .meta-editor textarea {
        width: 100%;
        padding: 8px 10px;
        border-radius: 10px;
        border: 1px solid var(--border-soft);
        background: var(--panel-2);
        color: var(--text);
        font-family: 'Space Grotesk', sans-serif;
      }
      .card-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
      .notice {
        font-size: 12px;
        color: var(--muted);
      }
      .toast {
        position: fixed;
        right: 18px;
        bottom: 18px;
        background: var(--panel);
        border: 1px solid var(--border-soft);
        padding: 12px 16px;
        border-radius: 12px;
        box-shadow: 0 10px 24px var(--shadow);
        display: none;
      }
      .toast.show { display: block; }
      .logs-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 12px;
      }
      .log-box {
        background: #12171d;
        border-radius: 12px;
        padding: 12px;
        border: 1px solid var(--border-soft);
        font-family: 'JetBrains Mono', monospace;
        font-size: 12px;
        color: #d6dde8;
        max-height: 240px;
        overflow: auto;
        white-space: pre-wrap;
      }
      .ag-grid {
        display: grid;
        gap: 12px;
      }
      .ag-card {
        background: var(--panel-2);
        border: 1px solid var(--border-soft);
        border-radius: 14px;
        padding: 12px 14px;
        display: grid;
        gap: 6px;
      }
      .ag-row {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        font-size: 13px;
      }
      .ag-label {
        color: var(--muted);
      }
      .ag-badge {
        padding: 4px 8px;
        border-radius: 999px;
        font-size: 11px;
        background: rgba(255,255,255,0.08);
        color: var(--muted);
      }
      .ag-badge.active {
        background: rgba(55, 211, 153, 0.15);
        color: var(--success);
      }
      .ag-badge.missing {
        background: rgba(255, 107, 107, 0.18);
        color: var(--danger);
      }
      .ag-actions {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
        justify-content: flex-end;
      }
      .ag-summary {
        display: grid;
        gap: 10px;
        grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
        margin: 12px 0;
      }
      /* Phase E: Force Mode Toggle Styles */
      .force-toggle-container {
        display: flex;
        align-items: center;
        gap: 12px;
      }
      .force-mode-controls {
        display: flex;
        align-items: center;
        gap: 12px;
        flex-wrap: wrap;
        justify-content: flex-end;
      }
      .force-strategy-inline {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .force-strategy-inline label {
        font-size: 12px;
        color: var(--muted);
      }
      .strategy-help {
        width: 18px;
        height: 18px;
        border-radius: 50%;
        border: 1px solid rgba(255,255,255,0.2);
        display: inline-flex;
        align-items: center;
        justify-content: center;
        font-size: 11px;
        color: var(--muted);
        cursor: help;
      }
      .toggle-switch {
        display: flex;
        align-items: center;
        gap: 10px;
        cursor: pointer;
      }
      .toggle-switch input {
        display: none;
      }
      .toggle-slider {
        width: 44px;
        height: 24px;
        background: rgba(255,255,255,0.12);
        border-radius: 12px;
        position: relative;
        transition: background 0.2s;
      }
      .toggle-slider::before {
        content: '';
        position: absolute;
        width: 20px;
        height: 20px;
        background: var(--text);
        border-radius: 50%;
        top: 2px;
        left: 2px;
        transition: transform 0.2s;
      }
      .toggle-switch input:checked + .toggle-slider {
        background: var(--accent);
      }
      .toggle-switch input:checked + .toggle-slider::before {
        transform: translateX(20px);
      }
      .toggle-switch input:disabled + .toggle-slider {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .toggle-label {
        font-size: 13px;
        color: var(--muted);
      }
      .toggle-switch input:checked ~ .toggle-label {
        color: var(--accent);
      }
      #forceAliasSelect {
        background: var(--panel-2);
        border: 1px solid var(--border-soft);
        border-radius: 8px;
        padding: 8px 12px;
        color: var(--text);
        font-family: inherit;
        font-size: 13px;
      }
      #rotationStrategySelect {
        background: var(--panel-2);
        border: 1px solid var(--border-soft);
        border-radius: 8px;
        padding: 8px 12px;
        color: var(--text);
        font-family: inherit;
        font-size: 13px;
      }
      @media (max-width: 720px) {
        header { padding: 26px 18px 10px; }
        .header-bar { flex-direction: column; align-items: stretch; }
        .container { padding: 0 16px 28px; }
        .actions { flex-direction: column; align-items: stretch; }
        button { width: 100%; }
      }
    </style>
  </head>
  <body>
    <header>
      <div class="header-bar">
        <div class="header-copy">
          <div class="header-kicker">Codex Special Functions</div>
          <h1>Codex Token Dashboard</h1>
          <div class="header-subtitle">Add and manage Codex accounts through the secure OAuth flow.</div>
        </div>
      </div>
    </header>
    <div class="container">
      <section class="panel">
        <div class="meta" id="meta"></div>
      </section>
      <section class="panel">
        <div class="actions">
          <button id="syncBtn">Sync auth.json</button>
          <button class="secondary" id="refreshTokensBtn">Refresh tokens (all)</button>
          <button class="secondary" id="refreshLimitsBtn">Refresh limits (all)</button>
          <button class="secondary" id="refreshBtn">Refresh UI</button>
        </div>
        <div class="add-row">
          <input id="addAliasInput" placeholder="New account alias (e.g., acc8)" />
          <button class="secondary" id="addAccountBtn">Add account</button>
        </div>
        <div class="queue" id="queue"></div>
        <div class="notice" id="notice"></div>
        <div class="notice" id="loginNotice"></div>
      </section>
      <section class="panel">
        <div class="filters">
          <input id="searchInput" placeholder="Search alias / email / tags / notes" />
          <input id="tagInput" placeholder="Filter tags (comma separated)" />
          <select id="sortSelect">
            <option value="recommended">Sort: Recommended first</option>
            <option value="fiveHour">Sort: 5h remaining</option>
            <option value="weekly">Sort: Weekly remaining</option>
            <option value="expiry">Sort: Expiry soon</option>
            <option value="refresh">Sort: Last refresh</option>
            <option value="alias">Sort: Alias</option>
          </select>
          <button class="secondary" id="clearFiltersBtn">Clear filters</button>
        </div>
      </section>
      <section class="accounts" id="accounts"></section>
      
      <!-- Phase E: Force Mode Section -->
      <section class="panel">
        <div class="logs-header">
          <div>
            <div style="font-size: 16px; font-weight: 600;">Force Mode</div>
            <div class="notice">Pin rotation to a specific account for 24 hours</div>
          </div>
          <div class="force-mode-controls" id="forceModeControls">
            <div class="force-toggle-container" id="forceToggleContainer">
              <label class="toggle-switch" id="forceToggleLabel" title="">
                <input type="checkbox" id="forceToggle" />
                <span class="toggle-slider"></span>
                <span class="toggle-label" id="forceToggleText">Off</span>
              </label>
              <span id="forceModeHelpIcon" class="strategy-help" title="">?</span>
              <select id="forceAliasSelect" style="display: none; margin-left: 12px;" title="">
                <option value="">Select account...</option>
              </select>
            </div>
            <div class="force-strategy-inline">
              <label for="rotationStrategySelect">Strategy</label>
              <select id="rotationStrategySelect" title="">
                <option value="round-robin" title="Cycle through enabled accounts in order.">round-robin</option>
                <option value="least-used" title="Prefer the enabled account with the lowest usage count.">least-used</option>
                <option value="random" title="Randomly pick from healthy accounts each request.">random</option>
                <option value="weighted-round-robin" title="Split requests by your account weights (example: 0.70/0.20/0.10 sends about 70%/20%/10%). Limited or disabled accounts are skipped automatically.">weighted-round-robin</option>
              </select>
              <span id="rotationStrategyHelpIcon" class="strategy-help" title="">?</span>
            </div>
          </div>
        </div>
        <div id="forceStatus" class="notice"></div>
        <div id="rotationStrategyStatus" class="notice"></div>
      </section>
      
      <!-- Phase G: Antigravity section - conditionally rendered based on feature flag -->
      <section class="panel" id="antigravitySection" style="display: none;">
        <div class="logs-header">
          <div>
            <div style="font-size: 16px; font-weight: 600;">Antigravity accounts</div>
            <div class="notice" id="antigravityPath"></div>
          </div>
        <div class="ag-actions">
            <button class="secondary" id="refreshAg">Refresh</button>
            <button class="secondary" id="refreshAgLimits">Refresh limits (active)</button>
            <button class="secondary" id="refreshAgLimitsAll">Refresh limits (all)</button>
            <button class="secondary" id="copyAgPath">Copy path</button>
            <button class="secondary" id="copyAgLogin">Copy reauth command</button>
          </div>
        </div>
        <div class="meta ag-summary" id="antigravitySummary"></div>
        <div class="notice" id="antigravityNotice"></div>
        <div class="limit-grid" id="antigravityQuota"></div>
        <div class="ag-grid" id="antigravityAccounts"></div>
        <div class="notice">Reauth: <code>opencode auth login</code> · Optional reset: remove the antigravity accounts file, then login again.</div>
      </section>
      <section class="panel">
        <div class="logs-header">
          <div>
            <div style="font-size: 16px; font-weight: 600;">Logs</div>
            <div class="notice" id="logPath"></div>
          </div>
          <button class="secondary" id="refreshLogsBtn">Refresh logs</button>
        </div>
        <pre class="log-box" id="logBox"></pre>
      </section>
    </div>
    <div class="toast" id="toast"></div>
    <script>
      const metaEl = document.getElementById('meta')
      const accountsEl = document.getElementById('accounts')
      const syncBtn = document.getElementById('syncBtn')
      const refreshTokensBtn = document.getElementById('refreshTokensBtn')
      const refreshLimitsBtn = document.getElementById('refreshLimitsBtn')
      const refreshBtn = document.getElementById('refreshBtn')
      const notice = document.getElementById('notice')
      const loginNotice = document.getElementById('loginNotice')
      const toast = document.getElementById('toast')
      const queueEl = document.getElementById('queue')
      const searchInput = document.getElementById('searchInput')
      const tagInput = document.getElementById('tagInput')
      const sortSelect = document.getElementById('sortSelect')
      const clearFiltersBtn = document.getElementById('clearFiltersBtn')
      const logBox = document.getElementById('logBox')
      const refreshLogsBtn = document.getElementById('refreshLogsBtn')
      const logPathEl = document.getElementById('logPath')
      const addAliasInput = document.getElementById('addAliasInput')
      const addAccountBtn = document.getElementById('addAccountBtn')
      const agPathEl = document.getElementById('antigravityPath')
      const agNoticeEl = document.getElementById('antigravityNotice')
      const agAccountsEl = document.getElementById('antigravityAccounts')
      const agSummaryEl = document.getElementById('antigravitySummary')
      const agQuotaEl = document.getElementById('antigravityQuota')
      const refreshAgBtn = document.getElementById('refreshAg')
      const refreshAgLimitsBtn = document.getElementById('refreshAgLimits')
      const refreshAgLimitsAllBtn = document.getElementById('refreshAgLimitsAll')
      const copyAgPathBtn = document.getElementById('copyAgPath')
      const copyAgLoginBtn = document.getElementById('copyAgLogin')
      
      // Phase G: Antigravity section element
      const antigravitySection = document.getElementById('antigravitySection')
      
      // Phase E: Force Mode elements
      const forceToggle = document.getElementById('forceToggle')
      const forceToggleText = document.getElementById('forceToggleText')
      const forceToggleLabel = document.getElementById('forceToggleLabel')
      const forceModeHelpIcon = document.getElementById('forceModeHelpIcon')
      const forceAliasSelect = document.getElementById('forceAliasSelect')
      const forceStatus = document.getElementById('forceStatus')
      const rotationStrategySelect = document.getElementById('rotationStrategySelect')
      const rotationStrategyStatus = document.getElementById('rotationStrategyStatus')
      const rotationStrategyHelpIcon = document.getElementById('rotationStrategyHelpIcon')

      let latestState = null
      let pollTimer = null
      let pollIntervalMs = 0
      let callbackUrlDraft = ''
      const rotationStrategyHelp = {
        'round-robin': 'Cycle through enabled accounts in order.',
        'least-used': 'Prefer the enabled account with the lowest usage count.',
        'random': 'Randomly pick from healthy accounts each request.',
        'weighted-round-robin': 'Split requests by your account weights (example: 0.70/0.20/0.10 sends about 70%/20%/10%). Limited or disabled accounts are skipped automatically.'
      }
      const forceModeHelpText = 'Force mode pins all requests to one selected account for up to 24 hours. While force mode is on, rotation strategy is paused.'
      const forceAliasHelpText = 'Choose the account that force mode should pin.'

      function showToast(text) {
        toast.textContent = text
        toast.classList.add('show')
        setTimeout(() => toast.classList.remove('show'), 2200)
      }

      function describeRotationStrategy(strategy) {
        return rotationStrategyHelp[strategy] || 'Rotation strategy controls how the next account is selected.'
      }

      function renderControlHelp(strategy) {
        if (forceToggleLabel) {
          forceToggleLabel.title = forceModeHelpText
        }
        if (forceToggle) {
          forceToggle.title = forceModeHelpText
        }
        if (forceModeHelpIcon) {
          forceModeHelpIcon.title = forceModeHelpText
        }
        if (forceAliasSelect) {
          forceAliasSelect.title = forceAliasHelpText
        }
        if (rotationStrategySelect) {
          rotationStrategySelect.title = describeRotationStrategy(strategy)
        }
      }

      function renderRotationStrategyHelp(strategy) {
        const description = describeRotationStrategy(strategy)
        const forceNotice = latestState?.force?.active
          ? ' Saved now, active after force mode is turned off.'
          : ' Active now while force mode is off.'
        const tooltip = description + ' Used when force mode is off.'
        renderControlHelp(strategy)
        if (rotationStrategySelect) {
          rotationStrategySelect.title = tooltip
        }
        if (rotationStrategyHelpIcon) {
          rotationStrategyHelpIcon.title = tooltip
        }
        if (rotationStrategyStatus) {
          rotationStrategyStatus.textContent = 'Rotation strategy: ' + strategy + ' — ' + description + forceNotice
        }
      }

      async function api(path, options) {
        const res = await fetch(path, {
          headers: { 'Content-Type': 'application/json' },
          ...options
        })
        if (!res.ok) {
          const msg = await res.text()
          throw new Error(msg || 'Request failed')
        }
        return res.json()
      }

      function formatDate(value) {
        if (!value) return 'unknown'
        return new Date(value).toLocaleString()
      }

      function formatRelative(value) {
        if (!value) return 'unknown'
        const ts = new Date(value).getTime()
        if (!Number.isFinite(ts)) return 'unknown'
        const diff = Date.now() - ts
        const minute = 60 * 1000
        const hour = 60 * minute
        const day = 24 * hour
        if (diff < minute) return 'just now'
        if (diff < hour) return Math.floor(diff / minute) + 'm ago'
        if (diff < day) return Math.floor(diff / hour) + 'h ago'
        return Math.floor(diff / day) + 'd ago'
      }

      function formatWhen(value) {
        if (!value) return 'unknown'
        return formatDate(value) + ' · ' + formatRelative(value)
      }

      function escapeHtml(value) {
        if (!value) return ''
        return value
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;')
      }

      function remainingPercent(window) {
        if (!window || typeof window.remaining !== 'number' || typeof window.limit !== 'number') return null
        if (window.limit === 0) return null
        return Math.round((window.remaining / window.limit) * 100)
      }

      function renderLimit(window, label, history, confidence) {
        // Phase C: Show "unknown" for missing data
        if (!window || confidence === 'unknown') {
          return \`
            <div class="limit-card">
              <strong>\${label}</strong>
              <span>Remaining: unknown</span><br />
              <span>Reset: unknown</span><br />
              <span>Updated: unknown</span>
            </div>
          \`
        }
        const remaining = window.remaining ?? '-'
        const limit = window.limit ?? '-'
        const isPercent = typeof remaining === 'number' && limit === 100
        const remainingText = isPercent ? remaining + '%' : remaining + ' / ' + limit
        const reset = window.resetAt ? formatDate(window.resetAt) : 'unknown'
        const updated = window.updatedAt ? formatDate(window.updatedAt) : 'unknown'
        const spark = renderSparkline(history, label === '5h limit' ? 'fiveHour' : 'weekly')
        
        // Phase C: Add confidence indicator
        const confidenceBadge = confidence && confidence !== 'fresh' 
          ? \`<span class="confidence-badge confidence-\${confidence}">\${confidence}</span>\` 
          : ''
        
        return \`
          <div class="limit-card">
            <strong>\${label} \${confidenceBadge}</strong>
            <span>Remaining: \${remainingText}</span><br />
            <span>Reset: \${reset}</span><br />
            <span>Updated: \${updated}</span>
            \${spark}
          </div>
        \`
      }

      function renderSparkline(history, key) {
        if (!history || history.length < 2) {
          return '<div class="sparkline"><span class="trend">No history</span></div>'
        }
        const values = history
          .map((entry) => {
            const snapshot = entry[key]
            if (!snapshot || typeof snapshot.remaining !== 'number') return null
            const limit = typeof snapshot.limit === 'number' && snapshot.limit > 0 ? snapshot.limit : 100
            return { at: entry.at, value: Math.round((snapshot.remaining / limit) * 100) }
          })
          .filter((entry) => entry && typeof entry.value === 'number')
          .slice(-20)

        if (values.length < 2) {
          return '<div class="sparkline"><span class="trend">No history</span></div>'
        }

        const width = 110
        const height = 28
        const max = 100
        const min = 0
        const step = width / (values.length - 1)
        const points = values.map((entry, idx) => {
          const x = idx * step
          const y = height - ((entry.value - min) / (max - min)) * height
          return \`\${x.toFixed(1)},\${y.toFixed(1)}\`
        })

        const trend = renderTrend(values)
        return \`
          <div class="sparkline">
            <svg viewBox="0 0 \${width} \${height}" preserveAspectRatio="none">
              <polyline
                fill="none"
                stroke="\${key === 'fiveHour' ? 'var(--accent-2)' : 'var(--accent)'}"
                stroke-width="2"
                points="\${points.join(' ')}"
              />
            </svg>
            <span class="trend">\${trend}</span>
          </div>
        \`
      }

      function renderTrend(values) {
        if (values.length < 2) return 'n/a'
        const last = values[values.length - 1]
        const prev = values[values.length - 2]
        const hours = (last.at - prev.at) / 3600000
        if (!hours || hours === 0) return 'n/a'
        const delta = last.value - prev.value
        const rate = delta / hours
        const sign = rate > 0 ? '+' : ''
        return \`Trend: \${sign}\${rate.toFixed(1)}%/h\`
      }

      function parseTags(value) {
        if (!value) return []
        return value
          .split(',')
          .map((tag) => tag.trim())
          .filter(Boolean)
      }

      function applyFilters(accounts) {
        const search = (searchInput.value || '').trim().toLowerCase()
        const tagFilter = parseTags(tagInput.value).map((tag) => tag.toLowerCase())

        return accounts.filter((acc) => {
          const tags = (acc.tags || []).map((tag) => tag.toLowerCase())
          const haystack = [
            acc.alias,
            acc.email,
            acc.accountId,
            ...(acc.tags || []),
            acc.notes || ''
          ]
            .filter(Boolean)
            .join(' ')
            .toLowerCase()

          if (search && !haystack.includes(search)) return false
          if (tagFilter.length > 0 && !tagFilter.some((tag) => tags.includes(tag))) return false
          return true
        })
      }

      function sortAccounts(accounts, state) {
        const mode = sortSelect.value
        const recommended = state.recommendedAlias

        const byAlias = (a, b) => a.alias.localeCompare(b.alias)

        const compareRemaining = (key) => (a, b) => {
          const aRemain = remainingPercent(a.rateLimits?.[key]) ?? -1
          const bRemain = remainingPercent(b.rateLimits?.[key]) ?? -1
          return bRemain - aRemain
        }

        const compareExpiry = (a, b) => {
          const aExp = a.expiresAt || 0
          const bExp = b.expiresAt || 0
          return aExp - bExp
        }

        const compareRefresh = (a, b) => {
          const aRef = a.lastRefresh ? Date.parse(a.lastRefresh) : 0
          const bRef = b.lastRefresh ? Date.parse(b.lastRefresh) : 0
          return bRef - aRef
        }

        let sorted = [...accounts]
        if (mode === 'fiveHour') sorted.sort(compareRemaining('fiveHour'))
        if (mode === 'weekly') sorted.sort(compareRemaining('weekly'))
        if (mode === 'expiry') sorted.sort(compareExpiry)
        if (mode === 'refresh') sorted.sort(compareRefresh)
        if (mode === 'alias') sorted.sort(byAlias)
        if (mode === 'recommended' && recommended) {
          sorted.sort((a, b) => {
            if (a.alias === recommended) return -1
            if (b.alias === recommended) return 1
            return byAlias(a, b)
          })
        }
        return sorted
      }

      function renderAccounts(state) {
        const filtered = sortAccounts(applyFilters(state.accounts), state)
        const cards = filtered.map((acc) => {
          const active = acc.alias === state.deviceAlias
          const recommended = acc.alias === state.recommendedAlias
          const badge = active ? 'On device' : 'Stored'
          const badgeClass = active ? 'badge' : 'badge inactive'
          const status = acc.limitStatus || 'idle'
          const statusLabels = {
            idle: 'idle',
            queued: 'queued',
            running: 'refreshing',
            success: 'ok',
            error: 'error',
            stopped: 'stopped'
          }
          const statusClass = \`status-badge status-\${status}\`
          const statusLabel = statusLabels[status] || status
          const tags = (acc.tags || []).map((tag) => \`<span class="tag-chip">\${escapeHtml(tag)}</span>\`).join('')
          const notes = acc.notes ? escapeHtml(acc.notes) : 'No notes yet.'
          const limitBlocks = [
            renderLimit(acc.rateLimits?.fiveHour, '5h limit', acc.rateLimitHistory, acc.limitsConfidence),
            renderLimit(acc.rateLimits?.weekly, 'Weekly limit', acc.rateLimitHistory, acc.limitsConfidence)
          ].join('')

          return \`
            <div class="account-card">
              <div class="account-title">
                <div class="account-heading">
                  <div class="account-name">\${escapeHtml(acc.alias)}</div>
                  <div class="account-subtitle">\${escapeHtml(acc.email || acc.accountId || 'unknown account')}</div>
                </div>
                <div class="account-badges">
                  <span class="\${badgeClass}">\${badge}</span>
                  \${recommended ? '<span class="badge recommended">Recommended</span>' : ''}
                  <span class="\${statusClass}">\${statusLabel}</span>
                </div>
              </div>
              <div class="account-meta">
                <div>Token expires: \${formatDate(acc.expiresAt)}</div>
                <div>Last seen: \${acc.lastSeenAt ? formatDate(acc.lastSeenAt) : acc.lastUsed ? formatDate(acc.lastUsed) : 'never'}</div>
                <div>Last refresh: \${acc.lastRefresh ? formatDate(acc.lastRefresh) : 'unknown'}</div>
                <div>Usage count: \${acc.usageCount ?? 0}</div>
                \${acc.limitError ? \`<div style="color: var(--danger);">Limit error: \${escapeHtml(acc.limitError)}</div>\` : ''}
              </div>
              <div class="limit-grid">\${limitBlocks || '<span class="notice">No rate-limit data yet.</span>'}</div>
              <div class="card-footer">
                <div class="tag-row">
                  \${tags || '<span class="notice">No tags yet.</span>'}
                  <button class="ghost small" data-action="edit-meta" data-alias="\${escapeHtml(acc.alias)}">Edit tags/notes</button>
                </div>
                <div class="notes">\${notes}</div>
                <div class="meta-editor" data-editor="\${escapeHtml(acc.alias)}">
                  <input data-field="tags" placeholder="tags: work, personal" value="\${escapeHtml((acc.tags || []).join(', '))}" />
                  <textarea data-field="notes" rows="3" placeholder="Notes">\${escapeHtml(acc.notes || '')}</textarea>
                  <button class="secondary small" data-action="save-meta" data-alias="\${escapeHtml(acc.alias)}">Save</button>
                </div>
                <!-- Phase D: Account controls with Enabled switch and Re-auth -->
                <div class="account-controls">
                  <label class="toggle-switch" data-alias="\${escapeHtml(acc.alias)}">
                    <input type="checkbox" \${acc.enabled !== false ? 'checked' : ''} data-action="toggle-enabled" data-alias="\${escapeHtml(acc.alias)}" />
                    <span class="toggle-slider"></span>
                    <span class="toggle-label">\${acc.enabled !== false ? 'Enabled' : 'Disabled'}</span>
                  </label>
                  <button class="secondary" data-action="reauth" data-alias="\${escapeHtml(acc.alias)}">Re-auth</button>
                </div>
                <div class="card-actions">
                  <button data-action="switch" data-alias="\${escapeHtml(acc.alias)}">Use on device</button>
                  <button class="secondary" data-action="refresh-token" data-alias="\${escapeHtml(acc.alias)}">Refresh token</button>
                  <button class="secondary" data-action="refresh" data-alias="\${escapeHtml(acc.alias)}">Refresh limits</button>
                  <!-- Phase D: Remove button kept, but disable mechanism is now via toggle -->
                  <button class="danger" data-action="remove" data-alias="\${escapeHtml(acc.alias)}">Remove</button>
                </div>
              </div>
            </div>
          \`
        }).join('')

        accountsEl.innerHTML = cards || '<div class="notice">No accounts yet. Sync auth.json first.</div>'
      }

      function renderMeta(state) {
        const storeStatus = state.storeStatus
        const storeLine = storeStatus.encrypted
          ? storeStatus.locked ? 'Encrypted (locked)' : 'Encrypted'
          : 'Plain'
        metaEl.innerHTML = \`
          <div class="meta-item">
            <span>Accounts</span>
            <strong>\${state.accounts.length}</strong>
          </div>
          <div class="meta-item">
            <span>On device</span>
            <strong>\${state.deviceAlias || 'none'}</strong>
          </div>
          <div class="meta-item">
            <span>Recommended token</span>
            <strong>\${state.recommendedAlias || 'n/a'}</strong>
          </div>
          <div class="meta-item">
            <span>auth.json path</span>
            <strong style="font-size: 13px;">\${state.authPath}</strong>
          </div>
          <div class="meta-item">
            <span>auth.json email</span>
            <strong style="font-size: 13px;">\${state.authSummary?.email || 'unknown'}</strong>
          </div>
          <div class="meta-item">
            <span>Store</span>
            <strong>\${storeLine}</strong>
          </div>
          <div class="meta-item">
            <span>Last sync</span>
            <strong>\${state.lastSyncAt ? formatDate(state.lastSyncAt) : 'never'}</strong>
          </div>
          <div class="meta-item">
            <span>Last synced alias</span>
            <strong>\${state.lastSyncAlias || 'none'}</strong>
          </div>
        \`
        notice.textContent = state.lastSyncError || storeStatus.error || ''
      }

      function renderLogin(state) {
        if (!loginNotice) return
        if (state.login) {
          const alias = escapeHtml(state.login.alias || 'account')
          const url = state.login.url ? escapeHtml(state.login.url) : ''
          const emailLine = state.login.email
            ? '<div class="notice">Email: ' + escapeHtml(state.login.email) + '</div>'
            : ''
          const stepLine = state.login.step
            ? '<div class="notice">Status: ' + escapeHtml(state.login.step) + '</div>'
            : ''
          const logs = Array.isArray(state.login.output) && state.login.output.length
            ? '<div class="notice">Recent: ' + state.login.output.map((line) => escapeHtml(line)).join(' · ') + '</div>'
            : ''
          const manualLink = url
            ? '<a href="' + url + '" target="_blank" rel="noreferrer">Open login manually</a>'
            : ''
          const callbackForm = state.login.mode === 'manual'
            ? '<div class="add-row" style="margin-top: 10px;">' +
              '<input id="callbackUrlInput" placeholder="Paste http://localhost:1455/auth/callback?..." value="' + escapeHtml(callbackUrlDraft) + '" />' +
              '<button class="secondary" id="submitCallbackBtn">Complete login</button>' +
              '</div>' +
              '<div class="notice">If localhost cannot connect, copy the full URL from the browser address bar and paste it here.</div>'
            : ''
          loginNotice.innerHTML =
            'Login in progress for <strong>' + alias + '</strong>' +
            (manualLink ? ' — ' + manualLink : '') +
            emailLine +
            stepLine +
            logs +
            callbackForm

          const callbackInput = document.getElementById('callbackUrlInput')
          const submitCallbackBtn = document.getElementById('submitCallbackBtn')
          if (callbackInput) {
            callbackInput.addEventListener('input', () => {
              callbackUrlDraft = callbackInput.value
            })
          }
          if (callbackInput && submitCallbackBtn) {
            submitCallbackBtn.addEventListener('click', async () => {
              const callbackUrl = callbackInput.value.trim()
              if (!callbackUrl) {
                showToast('Paste the localhost callback URL')
                return
              }
              try {
                await api('/api/auth/callback', {
                  method: 'POST',
                  body: JSON.stringify({ callbackUrl })
                })
                callbackUrlDraft = ''
                showToast('Callback submitted')
                await refreshState()
              } catch (err) {
                const message = err && typeof err === 'object' && 'message' in err ? String(err.message) : String(err)
                showToast(message)
              }
            })
          }
          return
        }
        callbackUrlDraft = ''
        if (state.lastLoginError) {
          loginNotice.textContent = 'Login error: ' + state.lastLoginError
          return
        }
        loginNotice.textContent = ''
      }

      function renderLoginControls(state) {
        if (addAccountBtn) {
          addAccountBtn.disabled = Boolean(state.login)
        }
        if (addAliasInput) {
          addAliasInput.disabled = Boolean(state.login)
        }
      }

      function renderQueue(state) {
        const queue = state.queue
        refreshLimitsBtn.disabled = Boolean(queue?.running)
        if (!queue) {
          queueEl.innerHTML = '<div class="notice">No refresh activity.</div>'
          return
        }
        const percent = queue.total ? Math.round((queue.completed / queue.total) * 100) : 0
        const statusLabel = queue.running ? 'Running' : queue.stopped ? 'Stopped' : 'Idle'
        const activeAliases = Array.isArray(queue.currentAliases) ? queue.currentAliases : []
        queueEl.innerHTML = \`
          <div class="notice">Queue: \${statusLabel} · \${queue.completed}/\${queue.total} · Errors: \${queue.errors} · Parallel: \${queue.active || 0}/\${queue.concurrency || 0}</div>
          <div class="progress-bar"><div class="progress-fill" style="width: \${percent}%"></div></div>
          <div class="notice">Current: \${activeAliases.length > 0 ? escapeHtml(activeAliases.join(', ')) : 'none'}</div>
          \${queue.running ? '<button class="danger small" id="stopQueueBtn">Stop refresh</button>' : ''}
        \`
        const stopBtn = document.getElementById('stopQueueBtn')
        if (stopBtn) {
          stopBtn.addEventListener('click', async () => {
            await api('/api/limits/stop', { method: 'POST', body: '{}' })
            showToast('Stopping queue')
            await refreshState()
          })
        }
      }

      function renderAntigravity(state) {
        // Phase G: Check if antigravity feature is enabled
        const featureFlags = state.featureFlags || {}
        const isEnabled = featureFlags.antigravityEnabled === true
        
        // Show/hide antigravity section based on feature flag
        if (antigravitySection) {
          antigravitySection.style.display = isEnabled ? 'block' : 'none'
        }
        
        // If disabled, don't render any antigravity content
        if (!isEnabled) {
          return
        }
        
        const ag = state.antigravity || {}
        if (agPathEl) {
          agPathEl.textContent = ag.path ? 'Path: ' + ag.path : ''
        }
        const quota = ag.quota || {}
        const quotaStatus = quota.status || 'idle'
        const quotaScope = quota.scope || 'active'
        const quotaFetched = quota.fetchedAt ? formatWhen(quota.fetchedAt) : 'never'
        if (agNoticeEl) {
          const errorBits = []
          if (ag.error) errorBits.push(ag.error)
          if (quotaStatus === 'error') {
            errorBits.push('Quota error: ' + (quota.error || 'unknown'))
          } else if (quotaStatus === 'ok') {
            errorBits.push('Quota updated: ' + quotaFetched)
          } else {
            errorBits.push('Quota not loaded yet')
          }
          agNoticeEl.textContent = errorBits.filter(Boolean).join(' · ')
        }
        if (agSummaryEl) {
          const accounts = Array.isArray(ag.accounts) ? ag.accounts : []
          const activeIndex = typeof ag.activeIndex === 'number' ? ag.activeIndex : null
          const activeAccount = activeIndex !== null ? accounts.find((acc) => acc.index === activeIndex) : null
          const activeLabel = activeAccount ? (activeAccount.alias || ('#' + activeAccount.index)) : '—'
          const lastRead = ag.readAt ? formatWhen(ag.readAt) : 'unknown'
          const hasResetTimes = accounts.some((acc) => acc.rateLimitResetTimes && Object.keys(acc.rateLimitResetTimes).length > 0)
          const hasLiveLimits = quotaStatus === 'ok' && quota.snapshot && Array.isArray(quota.snapshot.models) && quota.snapshot.models.length > 0
          const limitsLabel = hasLiveLimits
            ? (quotaScope === 'all' ? 'Live quotas (all)' : 'Live quotas (active)')
            : (hasResetTimes ? 'Reset times only' : 'n/a')
          agSummaryEl.innerHTML = '' +
            '<div class="meta-item"><span>Total</span><strong>' + accounts.length + '</strong></div>' +
            '<div class="meta-item"><span>Active</span><strong>' + escapeHtml(activeLabel) + '</strong></div>' +
            '<div class="meta-item"><span>Last read</span><strong>' + lastRead + '</strong></div>' +
            '<div class="meta-item"><span>Limits data</span><strong>' + limitsLabel + '</strong></div>'
        }
        if (agQuotaEl) {
          if (quotaStatus === 'ok' && quota.snapshot) {
            const snapshot = quota.snapshot
            const prompt = snapshot.promptCredits
            const promptCard = prompt ? (
              '<div class="limit-card">' +
                '<strong>Prompt credits</strong>' +
                '<span>Remaining: ' + prompt.available + ' / ' + prompt.monthly + '</span><br />' +
                '<span>Remaining %: ' + Math.round(prompt.remainingPercentage) + '%</span>' +
              '</div>'
            ) : ''
            const modelCards = (snapshot.models || []).map((model) => {
              const remaining = typeof model.remainingPercentage === 'number'
                ? Math.round(model.remainingPercentage) + '%'
                : 'unknown'
              const reset = model.timeUntilResetFormatted || (model.resetTime ? formatDate(model.resetTime) : 'unknown')
              return '' +
                '<div class="limit-card">' +
                  '<strong>' + escapeHtml(model.label || model.modelId || 'model') + '</strong>' +
                  '<span>Remaining: ' + remaining + '</span><br />' +
                  '<span>Reset: ' + reset + '</span>' +
                '</div>'
            }).join('')
            const none = !promptCard && !modelCards
            agQuotaEl.innerHTML = none
              ? '<div class="notice" style="grid-column: 1 / -1;">No quota data yet.</div>'
              : (promptCard + modelCards + '<div class="notice" style="grid-column: 1 / -1;">Limits reflect the ' + (quotaScope === 'all' ? 'last refreshed account' : 'active Antigravity account') + '.</div>')
          } else if (quotaStatus === 'error') {
            agQuotaEl.innerHTML = '<div class="notice" style="grid-column: 1 / -1;">Quota error: ' + escapeHtml(quota.error || 'unknown') + '</div>'
          } else {
            agQuotaEl.innerHTML = '<div class="notice" style="grid-column: 1 / -1;">Click "Refresh limits" to load Antigravity quotas.</div>'
          }
        }
        if (!agAccountsEl) return
        const accounts = Array.isArray(ag.accounts) ? ag.accounts : []
        if (accounts.length === 0) {
          agAccountsEl.innerHTML = '<div class="notice">No Antigravity accounts found.</div>'
          return
        }
        const perAccount = quota.perAccount || {}
        agAccountsEl.innerHTML = accounts.map((acc) => {
          const active = acc.index === ag.activeIndex
          const lastUsed = acc.lastUsed ? new Date(acc.lastUsed).getTime() : 0
          const stale = lastUsed ? (Date.now() - lastUsed) > (7 * 24 * 60 * 60 * 1000) : false
          const activeBadge = active ? '<span class="ag-badge active">Active</span>' : '<span class="ag-badge">Stored</span>'
          const tokenBadge = acc.hasRefreshToken ? '<span class="ag-badge">token</span>' : '<span class="ag-badge missing">missing token</span>'
          const staleBadge = stale ? '<span class="ag-badge missing">stale</span>' : ''
          const resetEntries = acc.rateLimitResetTimes ? Object.entries(acc.rateLimitResetTimes) : []
          const resetText = resetEntries.length
            ? resetEntries.map(([key, value]) => escapeHtml(key) + ': ' + formatWhen(value)).join(' · ')
            : 'unknown (no reset info)'
          const quotaSnapshot = perAccount[acc.index]
          const quotaPrompt = quotaSnapshot?.promptCredits
          const quotaModels = quotaSnapshot?.models || []
          const quotaSummary = quotaSnapshot
            ? (
                '<div class="ag-row"><span class="ag-label">Quota updated</span><span>' + formatWhen(quotaSnapshot.timestamp) + '</span></div>' +
                (quotaSnapshot.email ? '<div class="ag-row"><span class="ag-label">Quota email</span><span>' + escapeHtml(quotaSnapshot.email) + '</span></div>' : '') +
                (quotaPrompt
                  ? '<div class="ag-row"><span class="ag-label">Prompt credits</span><span>' + quotaPrompt.available + ' / ' + quotaPrompt.monthly + '</span></div>'
                  : '') +
                (quotaModels.length
                  ? '<div class="ag-row"><span class="ag-label">Models</span><span>' +
                      quotaModels.slice(0, 3).map((model) => {
                        const remaining = typeof model.remainingPercentage === 'number' ? Math.round(model.remainingPercentage) + '%' : 'n/a'
                        return escapeHtml(model.label || model.modelId || 'model') + ': ' + remaining
                      }).join(' · ') +
                    '</span></div>'
                  : '')
              )
            : '<div class="ag-row"><span class="ag-label">Quota</span><span>not loaded</span></div>'
          return '' +
            '<div class="ag-card">' +
              '<div class="ag-row">' +
                '<strong>' + escapeHtml(acc.alias || ('#' + acc.index)) + '</strong>' +
                '<div style="display:flex; gap:6px;">' + activeBadge + tokenBadge + staleBadge + '</div>' +
              '</div>' +
              '<div class="ag-row"><span class="ag-label">Project</span><span>' + escapeHtml(acc.projectId || 'unknown') + '</span></div>' +
              '<div class="ag-row"><span class="ag-label">Managed</span><span>' + escapeHtml(acc.managedProjectId || '—') + '</span></div>' +
              '<div class="ag-row"><span class="ag-label">Added</span><span>' + (acc.addedAt ? formatWhen(acc.addedAt) : 'unknown') + '</span></div>' +
              '<div class="ag-row"><span class="ag-label">Last used</span><span>' + (acc.lastUsed ? formatWhen(acc.lastUsed) : 'never') + '</span></div>' +
              '<div class="ag-row"><span class="ag-label">Limits reset</span><span>' + resetText + '</span></div>' +
              quotaSummary +
            '</div>'
        }).join('')
      }

      function updatePolling(queue) {
        const nextInterval = queue?.running || latestState?.login ? 2000 : 5000
        if (pollTimer && pollIntervalMs === nextInterval) return
        if (pollTimer) {
          clearInterval(pollTimer)
          pollTimer = null
        }
        pollIntervalMs = nextInterval
        pollTimer = setInterval(() => {
          if (document.hidden) return
          refreshState().catch(() => {})
        }, nextInterval)
      }

      async function refreshLogs() {
        const logs = await api('/api/logs')
        logPathEl.textContent = logs.path ? \`Path: \${logs.path}\` : ''
        logBox.textContent = (logs.lines || []).join('\\n') || 'No logs yet.'
      }

      async function refreshState() {
        const state = await api('/api/state')
        latestState = state
        renderMeta(state)
        renderQueue(state)
        renderAccounts(state)
        renderLogin(state)
        renderLoginControls(state)
        renderAntigravity(state)
        updatePolling(state.queue)
        await renderForceMode()
      }

      accountsEl.addEventListener('click', async (event) => {
        const target = event.target
        if (!(target instanceof HTMLElement)) return
        const alias = target.dataset.alias
        const action = target.dataset.action
        if (!alias || !action) return

        if (action === 'switch') {
          await api('/api/switch', { method: 'POST', body: JSON.stringify({ alias }) })
          showToast('Switched auth.json')
          await refreshState()
          return
        }
        if (action === 'refresh-token') {
          const result = await api('/api/token/refresh', { method: 'POST', body: JSON.stringify({ alias }) })
          const failures = result.results?.filter((item) => item.error) || []
          showToast(failures.length ? 'Token: ' + failures[0].error : 'Token refreshed')
          await refreshState()
          return
        }
        if (action === 'refresh') {
          await api('/api/limits/refresh', { method: 'POST', body: JSON.stringify({ alias }) })
          showToast('Refreshing limits')
          await refreshState()
          return
        }
        if (action === 'remove') {
          await api('/api/remove', { method: 'POST', body: JSON.stringify({ alias }) })
          showToast('Account removed')
          await refreshState()
          return
        }
        if (action === 'edit-meta') {
          const editor = document.querySelector(\`.meta-editor[data-editor="\${CSS.escape(alias)}"]\`)
          if (editor) {
            editor.classList.toggle('show')
          }
          return
        }
        if (action === 'save-meta') {
          const editor = document.querySelector('.meta-editor[data-editor="' + CSS.escape(alias) + '"]')
          if (!editor) return
          const tagsInput = editor.querySelector('input[data-field="tags"]')
          const notesInput = editor.querySelector('textarea[data-field="notes"]')
          const tags = tagsInput ? tagsInput.value : ''
          const notes = notesInput ? notesInput.value : ''
          await api('/api/account/meta', {
            method: 'POST',
            body: JSON.stringify({ alias, tags, notes })
          })
          showToast('Saved tags/notes')
          await refreshState()
        }
        
        // Phase D: Toggle enabled state
        if (action === 'toggle-enabled') {
          const checkbox = target
          const enabled = checkbox.checked
          const toggleLabel = checkbox.closest('.toggle-switch')?.querySelector('.toggle-label')
          
          // Phase D: Double-submit protection - disable during request
          checkbox.disabled = true
          if (toggleLabel) {
            toggleLabel.textContent = enabled ? 'Enabling...' : 'Disabling...'
          }
          
          try {
            const result = await api(\`/api/accounts/\${encodeURIComponent(alias)}/enabled\`, {
              method: 'PUT',
              body: JSON.stringify({ enabled })
            })
            showToast(result.enabled ? 'Account enabled' : 'Account disabled')
            if (toggleLabel) {
              toggleLabel.textContent = result.enabled ? 'Enabled' : 'Disabled'
            }
          } catch (err) {
            // Revert checkbox on error
            checkbox.checked = !enabled
            if (toggleLabel) {
              toggleLabel.textContent = !enabled ? 'Enabled' : 'Disabled'
            }
            showToast('Error: ' + err.message)
          } finally {
            checkbox.disabled = false
          }
          await refreshState()
          return
        }
        
        // Phase D: Re-auth action
        if (action === 'reauth') {
          const button = target
          const originalText = button.textContent
          button.disabled = true
          button.textContent = 'Starting...'
          
          try {
            const result = await api(\`/api/accounts/\${encodeURIComponent(alias)}/reauth\`, {
              method: 'POST',
              body: JSON.stringify({ actor: 'dashboard' })
            })
            
            if (result.url) {
              showToast('Opening OAuth flow...')
              window.open(result.url, '_blank')
            } else {
              showToast('Re-auth started')
            }
            
            button.textContent = 'In Progress...'
            
            // Poll for completion
            let attempts = 0
            const maxAttempts = 60 // 2 minutes at 2 second intervals
            const pollInterval = setInterval(async () => {
              attempts++
              const state = await api('/api/state')
              const account = state.accounts?.find(a => a.alias === alias)
              
              if (account && account.lastRefresh) {
                const lastRefreshTime = new Date(account.lastRefresh).getTime()
                if (lastRefreshTime > Date.now() - 60000) { // refreshed in last minute
                  clearInterval(pollInterval)
                  button.textContent = 'Success!'
                  showToast('Re-auth completed successfully')
                  setTimeout(() => {
                    button.disabled = false
                    button.textContent = originalText
                  }, 2000)
                  await refreshState()
                }
              }
              
              if (attempts >= maxAttempts) {
                clearInterval(pollInterval)
                button.textContent = 'Timed Out'
                showToast('Re-auth timed out. Check logs.')
                setTimeout(() => {
                  button.disabled = false
                  button.textContent = originalText
                }, 2000)
              }
            }, 2000)
            
          } catch (err) {
            showToast('Error: ' + err.message)
            button.disabled = false
            button.textContent = originalText
          }
          return
        }
      })

      syncBtn.addEventListener('click', async () => {
        await api('/api/sync', { method: 'POST', body: '{}' })
        showToast('Synced auth.json')
        await refreshState()
      })

      refreshTokensBtn.addEventListener('click', async () => {
        const result = await api('/api/token/refresh', { method: 'POST', body: '{}' })
        const failures = result.results?.filter((item) => item.error) || []
        if (failures.length === 0) {
          showToast('Tokens refreshed')
        } else {
          showToast('Tokens: ' + failures.length + ' failed')
        }
        await refreshState()
      })

      refreshLimitsBtn.addEventListener('click', async () => {
        await api('/api/limits/refresh', { method: 'POST', body: '{}' })
        showToast('Refreshing limits')
        await refreshState()
      })

      refreshBtn.addEventListener('click', async () => {
        await refreshState()
        showToast('Refreshed')
      })

      refreshLogsBtn.addEventListener('click', async () => {
        await refreshLogs()
        showToast('Logs refreshed')
      })

      if (copyAgLoginBtn) {
        copyAgLoginBtn.addEventListener('click', async () => {
          try {
            await navigator.clipboard.writeText('opencode auth login')
            showToast('Command copied')
          } catch {
            showToast('Copy failed')
          }
        })
      }

      if (refreshAgBtn) {
        refreshAgBtn.addEventListener('click', async () => {
          await refreshState()
          showToast('Antigravity refreshed')
        })
      }

      if (refreshAgLimitsBtn) {
        refreshAgLimitsBtn.addEventListener('click', async () => {
          await api('/api/antigravity/refresh', { method: 'POST', body: '{}' })
          await refreshState()
          showToast('Antigravity limits refreshed')
        })
      }

      if (refreshAgLimitsAllBtn) {
        refreshAgLimitsAllBtn.addEventListener('click', async () => {
          await api('/api/antigravity/refresh-all', { method: 'POST', body: '{}' })
          await refreshState()
          showToast('Antigravity limits refreshed (all)')
        })
      }

      if (copyAgPathBtn) {
        copyAgPathBtn.addEventListener('click', async () => {
          try {
            const path = latestState?.antigravity?.path || ''
            if (path) {
              await navigator.clipboard.writeText(path)
              showToast('Path copied')
            } else {
              showToast('No path')
            }
          } catch {
            showToast('Copy failed')
          }
        })
      }

      if (addAccountBtn && addAliasInput) {
        const startLogin = async () => {
          const raw = addAliasInput.value.trim()
          const alias = raw || 'account-' + Date.now()
          try {
            const result = await api('/api/auth/start', {
              method: 'POST',
              body: JSON.stringify({ alias })
            })
            addAliasInput.value = alias
            showToast('Open login URL')
            if (result?.url) {
              window.open(result.url, '_blank')
            }
            await refreshState()
          } catch (err) {
            showToast('Login start failed')
          }
        }
        addAccountBtn.addEventListener('click', startLogin)
        addAliasInput.addEventListener('keydown', (event) => {
          if (event.key === 'Enter') startLogin()
        })
      }

      searchInput.addEventListener('input', () => {
        if (latestState) renderAccounts(latestState)
      })
      tagInput.addEventListener('input', () => {
        if (latestState) renderAccounts(latestState)
      })
      sortSelect.addEventListener('change', () => {
        if (latestState) renderAccounts(latestState)
      })
      clearFiltersBtn.addEventListener('click', () => {
        searchInput.value = ''
        tagInput.value = ''
        sortSelect.value = 'recommended'
        if (latestState) renderAccounts(latestState)
      })

      // Phase E: Force Mode UI functions
      async function renderForceMode() {
        try {
          const forceData = await api('/api/force', { method: 'GET' })
          
          if (forceToggle && forceToggleText && forceAliasSelect && forceStatus) {
            // Update toggle state
            forceToggle.checked = forceData.active
            forceToggle.disabled = false
            
            if (forceData.active) {
              forceToggleText.textContent = 'On (' + forceData.remainingTime + ')'
              forceStatus.innerHTML = 'Force mode active for <strong>' + escapeHtml(forceData.alias) + '</strong> — ' + escapeHtml(forceData.remainingTime) + ' remaining'
              forceAliasSelect.style.display = 'none'
            } else {
              forceToggleText.textContent = 'Off'
              forceStatus.textContent = 'Force mode disabled. Rotation will use normal strategy.'
              
              // Populate alias select if not active
              if (latestState && latestState.accounts) {
                const enabledAccounts = latestState.accounts.filter(acc => acc.enabled !== false)
                forceAliasSelect.innerHTML = '<option value="">Select account...</option>' +
                  enabledAccounts.map(acc => '<option value="' + escapeHtml(acc.alias) + '">' + escapeHtml(acc.alias) + '</option>').join('')
              }
            }
          }

          if (rotationStrategySelect) {
            const strategy = latestState?.rotationStrategy || 'round-robin'
            rotationStrategySelect.value = strategy
            rotationStrategySelect.disabled = false
            renderRotationStrategyHelp(strategy)
          }
        } catch (err) {
          console.error('Failed to load force state:', err)
          if (forceStatus) {
            forceStatus.textContent = 'Failed to load force mode state'
          }
          if (rotationStrategyStatus) {
            rotationStrategyStatus.textContent = 'Failed to load strategy'
          }
        }
      }

      // Force toggle event listener
      if (forceToggle) {
        forceToggle.addEventListener('change', async () => {
          const isChecked = forceToggle.checked
          forceToggle.disabled = true
          
          try {
            if (isChecked) {
              // Show alias selector when enabling
              if (forceAliasSelect) {
                forceAliasSelect.style.display = 'inline-block'
                forceToggleText.textContent = 'Select account...'
                forceToggle.disabled = false
              }
            } else {
              // Disable force mode
              await api('/api/force/clear', { method: 'POST' })
              showToast('Force mode disabled')
              await renderForceMode()
            }
          } catch (err) {
            showToast('Error: ' + err.message)
            forceToggle.checked = !isChecked
            forceToggle.disabled = false
          }
        })
      }

      // Force alias selection
      if (forceAliasSelect) {
        forceAliasSelect.addEventListener('change', async () => {
          const alias = forceAliasSelect.value
          if (!alias) return
          
          forceAliasSelect.disabled = true
          
          try {
            await api('/api/force', { 
              method: 'POST', 
              body: JSON.stringify({ alias, actor: 'dashboard' }) 
            })
            showToast('Force mode enabled for ' + alias)
            forceAliasSelect.style.display = 'none'
            await renderForceMode()
          } catch (err) {
            showToast('Error: ' + err.message)
            forceAliasSelect.value = ''
          } finally {
            forceAliasSelect.disabled = false
          }
        })
      }

      if (rotationStrategySelect) {
        rotationStrategySelect.addEventListener('change', async () => {
          const previous = latestState?.rotationStrategy || 'round-robin'
          const rotationStrategy = rotationStrategySelect.value
          renderRotationStrategyHelp(rotationStrategy)
          rotationStrategySelect.disabled = true
          try {
            await api('/api/settings', {
              method: 'PUT',
              body: JSON.stringify({
                rotationStrategy,
                actor: 'dashboard'
              })
            })
            showToast('Rotation strategy set to ' + rotationStrategy)
            await refreshState()
          } catch (err) {
            rotationStrategySelect.value = previous
            renderRotationStrategyHelp(previous)
            showToast('Error: ' + err.message)
          } finally {
            rotationStrategySelect.disabled = false
          }
        })
      }

      renderControlHelp('round-robin')
      refreshState().catch((err) => {
        console.error(err)
        notice.textContent = 'Failed to load state.'
      })
      updatePolling({ running: false })
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) refreshState().catch(() => {})
      })
      refreshLogs().catch(() => {
        logBox.textContent = 'No logs yet.'
      })
    </script>
  </body>
</html>`;
function sendJson(res, status, payload) {
    const data = JSON.stringify(payload);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(data)
    });
    res.end(data);
}
function scrubAccount(account) {
    const { accessToken, refreshToken, idToken, ...rest } = account;
    return rest;
}
async function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        let data = '';
        req.on('data', (chunk) => {
            data += chunk;
            if (data.length > 1_000_000) {
                req.destroy();
                const payloadError = new Error('Payload too large');
                payloadError.code = 'PAYLOAD_TOO_LARGE';
                reject(payloadError);
            }
        });
        req.on('end', () => {
            if (!data) {
                resolve({});
                return;
            }
            try {
                resolve(JSON.parse(data));
            }
            catch {
                const parseError = new Error('Invalid JSON payload');
                parseError.code = 'INVALID_JSON';
                reject(parseError);
            }
        });
    });
}
function remainingPercent(window) {
    if (!window || typeof window.remaining !== 'number' || typeof window.limit !== 'number')
        return null;
    if (window.limit === 0)
        return null;
    return Math.round((window.remaining / window.limit) * 100);
}
function recommendAlias(accounts) {
    let best = null;
    for (const account of accounts) {
        if (account.enabled === false) {
            continue;
        }
        const weeklyPercent = remainingPercent(account.rateLimits?.weekly) ?? -1;
        const weeklyRemaining = typeof account.rateLimits?.weekly?.remaining === 'number'
            ? account.rateLimits.weekly.remaining
            : -1;
        const fivePercent = remainingPercent(account.rateLimits?.fiveHour) ?? -1;
        if (weeklyPercent < 0 && weeklyRemaining < 0 && fivePercent < 0) {
            continue;
        }
        if (!best ||
            weeklyPercent > best.weeklyPercent ||
            (weeklyPercent === best.weeklyPercent && weeklyRemaining > best.weeklyRemaining) ||
            (weeklyPercent === best.weeklyPercent &&
                weeklyRemaining === best.weeklyRemaining &&
                fivePercent > best.fivePercent)) {
            best = { alias: account.alias, weeklyPercent, weeklyRemaining, fivePercent };
        }
    }
    return best?.alias ?? null;
}
function setPendingLogin(state) {
    pendingLogin = state;
}
function updatePendingLogin(patch) {
    if (!pendingLogin)
        return;
    pendingLogin = {
        ...pendingLogin,
        ...patch,
        output: patch.output ?? pendingLogin.output
    };
}
function startManualLogin(alias) {
    if (pendingLogin) {
        throw new Error(`Login already in progress for ${pendingLogin.alias}`);
    }
    return createAuthorizationFlow().then((flow) => {
        let resolveCallbackUrl = () => { };
        const callbackUrl = new Promise((resolve) => {
            resolveCallbackUrl = resolve;
        });
        pendingManualCallback = { alias, flow, resolve: resolveCallbackUrl };
        setPendingLogin({
            alias,
            startedAt: Date.now(),
            url: flow.url,
            mode: 'manual',
            status: 'waiting-callback',
            step: 'Waiting for localhost callback or pasted callback URL...',
            output: []
        });
        lastLoginError = null;
        loginAccount(alias, flow, { timeoutMs: LOGIN_TIMEOUT_MS, callbackUrl })
            .then(() => {
            logInfo(`Login completed for ${alias}`);
            setPendingLogin(null);
        })
            .catch((err) => {
            lastLoginError = String(err);
            logError(`Login failed for ${alias}: ${err}`);
            setPendingLogin(null);
        })
            .finally(() => {
            if (pendingManualCallback?.alias === alias) {
                pendingManualCallback = null;
            }
        });
        return { ok: true, url: flow.url };
    });
}
function runSync() {
    try {
        const result = syncCodexAuthFile();
        const authStatus = getCodexAuthStatus();
        lastSyncAt = Date.now();
        lastSyncError = authStatus.error;
        lastSyncAlias = result.alias ?? null;
        if (result.updated || result.added) {
            logInfo(`Synced auth.json (${result.alias ?? 'none'})`);
        }
        if (authStatus.error) {
            logError(authStatus.error);
        }
    }
    catch (err) {
        lastSyncError = String(err);
        logError(`Sync failed: ${lastSyncError}`);
    }
}
function loadAntigravityAccounts() {
    const result = { path: ANTIGRAVITY_ACCOUNTS_FILE, accounts: [], readAt: Date.now() };
    if (!fs.existsSync(ANTIGRAVITY_ACCOUNTS_FILE)) {
        return { ...result, error: 'antigravity-accounts.json not found' };
    }
    try {
        const raw = JSON.parse(fs.readFileSync(ANTIGRAVITY_ACCOUNTS_FILE, 'utf-8'));
        const activeIndex = typeof raw?.activeIndex === 'number' ? raw.activeIndex : undefined;
        const accounts = Array.isArray(raw?.accounts) ? raw.accounts : [];
        const view = accounts.map((acc, index) => ({
            index,
            alias: acc?.projectId || acc?.managedProjectId,
            projectId: acc?.projectId,
            managedProjectId: acc?.managedProjectId,
            addedAt: acc?.addedAt,
            lastUsed: acc?.lastUsed,
            hasRefreshToken: Boolean(acc?.refreshToken),
            rateLimitResetTimes: acc?.rateLimitResetTimes && typeof acc.rateLimitResetTimes === 'object'
                ? acc.rateLimitResetTimes
                : undefined
        }));
        return { ...result, activeIndex, accounts: view };
    }
    catch (err) {
        return { ...result, error: `Failed to parse antigravity accounts: ${err}` };
    }
}
function isAntigravityProcessLine(line) {
    const lower = line.toLowerCase();
    if (lower.includes('antigravity'))
        return true;
    return /--app_data_dir\s+antigravity\b/i.test(line);
}
function getAntigravityProcessName() {
    if (process.platform === 'darwin') {
        return `language_server_macos${process.arch === 'arm64' ? '_arm' : ''}`;
    }
    if (process.platform === 'linux') {
        return `language_server_linux${process.arch === 'arm64' ? '_arm' : '_x64'}`;
    }
    if (process.platform === 'win32') {
        return 'language_server_windows_x64.exe';
    }
    return null;
}
async function detectAntigravityProcessInfo() {
    const processName = getAntigravityProcessName();
    if (!processName) {
        throw new Error('Unsupported platform for Antigravity quotas');
    }
    if (process.platform === 'win32') {
        throw new Error('Antigravity quota detection is not implemented for Windows yet');
    }
    const cmd = process.platform === 'darwin' ? `pgrep -fl ${processName}` : `pgrep -af ${processName}`;
    const { stdout } = await execAsync(cmd);
    const lines = stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
    const tokenLines = lines.filter((line) => line.includes('--csrf_token'));
    if (tokenLines.length === 0) {
        return null;
    }
    const ordered = [
        ...tokenLines.filter(isAntigravityProcessLine),
        ...tokenLines.filter((line) => !isAntigravityProcessLine(line))
    ];
    for (const line of ordered) {
        const parts = line.split(/\s+/);
        const pid = Number(parts[0]);
        if (!Number.isFinite(pid)) {
            continue;
        }
        const portMatch = line.match(/--extension_server_port[=\s]+(\d+)/);
        const tokenMatch = line.match(/--csrf_token[=\s]+([a-zA-Z0-9\-]+)/);
        if (!tokenMatch) {
            continue;
        }
        const extensionPort = portMatch ? Number(portMatch[1]) : 0;
        const csrfToken = tokenMatch[1];
        const ports = await listListeningPorts(pid);
        const workingPort = await findWorkingPort(ports, csrfToken);
        const connectPort = workingPort || (extensionPort > 0 ? extensionPort : 0);
        if (!connectPort) {
            return null;
        }
        return { pid, extensionPort, csrfToken, connectPort };
    }
    return null;
}
async function listListeningPorts(pid) {
    try {
        const cmd = `lsof -nP -a -iTCP -sTCP:LISTEN -p ${pid}`;
        const { stdout } = await execAsync(cmd);
        const ports = new Set();
        const regex = /:(\d+)\s+\(LISTEN\)/g;
        let match;
        while ((match = regex.exec(stdout)) !== null) {
            const port = Number(match[1]);
            if (Number.isFinite(port)) {
                ports.add(port);
            }
        }
        return Array.from(ports.values()).sort((a, b) => a - b);
    }
    catch {
        return [];
    }
}
function antigravityRequest(port, csrfToken, pathName, body) {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify(body);
        const req = https.request({
            hostname: '127.0.0.1',
            port,
            path: pathName,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
                'Connect-Protocol-Version': '1',
                'X-Codeium-Csrf-Token': csrfToken
            },
            rejectUnauthorized: false,
            timeout: 5000
        }, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                }
                catch {
                    reject(new Error('Invalid JSON response'));
                }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Request timeout'));
        });
        req.write(payload);
        req.end();
    });
}
async function testAntigravityPort(port, csrfToken) {
    try {
        await antigravityRequest(port, csrfToken, '/exa.language_server_pb.LanguageServerService/GetUnleashData', { wrapper_data: {} });
        return true;
    }
    catch {
        return false;
    }
}
async function findWorkingPort(ports, csrfToken) {
    for (const port of ports) {
        const ok = await testAntigravityPort(port, csrfToken);
        if (ok)
            return port;
    }
    return null;
}
function formatAntigravityDuration(ms, resetTime) {
    if (!Number.isFinite(ms) || ms <= 0)
        return 'Ready';
    const mins = Math.ceil(ms / 60000);
    let duration = '';
    if (mins < 60) {
        duration = `${mins}m`;
    }
    else {
        const hours = Math.floor(mins / 60);
        duration = `${hours}h ${mins % 60}m`;
    }
    if (!resetTime)
        return duration;
    const resetDate = new Date(resetTime);
    const dateStr = resetDate.toLocaleDateString(undefined, { day: '2-digit', month: '2-digit', year: 'numeric' });
    const timeStr = resetDate.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
    return `${duration} (${dateStr} ${timeStr})`;
}
function updateAntigravityActiveIndex(raw, index) {
    const next = { ...raw };
    next.activeIndex = index;
    if (next.activeIndexByFamily && typeof next.activeIndexByFamily === 'object') {
        next.activeIndexByFamily = { ...next.activeIndexByFamily };
        for (const key of Object.keys(next.activeIndexByFamily)) {
            next.activeIndexByFamily[key] = index;
        }
    }
    return next;
}
async function refreshAntigravityQuotaAll() {
    if (antigravityQuotaInFlight) {
        return antigravityQuotaInFlight;
    }
    antigravityQuotaInFlight = (async () => {
        let originalRaw = '';
        let parsed;
        try {
            if (!fs.existsSync(ANTIGRAVITY_ACCOUNTS_FILE)) {
                throw new Error('antigravity-accounts.json not found');
            }
            originalRaw = fs.readFileSync(ANTIGRAVITY_ACCOUNTS_FILE, 'utf-8');
            parsed = JSON.parse(originalRaw);
            const accounts = Array.isArray(parsed?.accounts) ? parsed.accounts : [];
            if (accounts.length === 0) {
                throw new Error('No Antigravity accounts available');
            }
            const perAccount = {};
            for (let index = 0; index < accounts.length; index += 1) {
                const next = updateAntigravityActiveIndex(parsed, index);
                fs.writeFileSync(ANTIGRAVITY_ACCOUNTS_FILE, JSON.stringify(next, null, 2));
                await new Promise((resolve) => setTimeout(resolve, 500));
                const snapshot = await fetchAntigravityQuota();
                perAccount[index] = snapshot;
            }
            antigravityQuotaState = {
                status: 'ok',
                scope: 'all',
                fetchedAt: Date.now(),
                snapshot: perAccount[parsed.activeIndex ?? 0] || perAccount[0],
                perAccount
            };
        }
        catch (err) {
            antigravityQuotaState = {
                status: 'error',
                scope: 'all',
                fetchedAt: Date.now(),
                error: String(err),
                perAccount: antigravityQuotaState.perAccount
            };
        }
        finally {
            if (originalRaw) {
                try {
                    fs.writeFileSync(ANTIGRAVITY_ACCOUNTS_FILE, originalRaw);
                }
                catch (err) {
                    logError(`Failed to restore antigravity accounts file: ${err}`);
                }
            }
            antigravityQuotaInFlight = null;
        }
        return antigravityQuotaState;
    })();
    return antigravityQuotaInFlight;
}
function parseAntigravityQuota(data) {
    const userStatus = data?.userStatus;
    const planInfo = userStatus?.planStatus?.planInfo;
    const availableCredits = userStatus?.planStatus?.availablePromptCredits;
    let promptCredits;
    if (planInfo && availableCredits !== undefined) {
        const monthly = Number(planInfo.monthlyPromptCredits);
        const available = Number(availableCredits);
        if (Number.isFinite(monthly) && monthly > 0) {
            promptCredits = {
                available,
                monthly,
                usedPercentage: ((monthly - available) / monthly) * 100,
                remainingPercentage: (available / monthly) * 100
            };
        }
    }
    const rawModels = userStatus?.cascadeModelConfigData?.clientModelConfigs || [];
    const models = rawModels
        .filter((model) => model?.quotaInfo)
        .map((model) => {
        const reset = model.quotaInfo?.resetTime ? new Date(model.quotaInfo.resetTime) : null;
        const resetTime = reset ? reset.getTime() : undefined;
        const remainingFraction = typeof model.quotaInfo?.remainingFraction === 'number'
            ? model.quotaInfo.remainingFraction
            : undefined;
        const remainingPercentage = typeof remainingFraction === 'number'
            ? remainingFraction * 100
            : undefined;
        const diff = resetTime ? resetTime - Date.now() : undefined;
        const label = model.label || model.modelOrAlias?.model || 'model';
        const modelId = model.modelOrAlias?.model || model.modelOrAlias?.alias || 'unknown';
        return {
            label,
            modelId,
            remainingFraction,
            remainingPercentage,
            isExhausted: remainingFraction === 0,
            resetTime,
            timeUntilResetMs: diff,
            timeUntilResetFormatted: typeof diff === 'number' ? formatAntigravityDuration(diff, resetTime) : undefined
        };
    });
    return {
        timestamp: Date.now(),
        name: userStatus?.name,
        email: userStatus?.email,
        promptCredits,
        models
    };
}
async function fetchAntigravityQuota() {
    const info = await detectAntigravityProcessInfo();
    if (!info) {
        throw new Error('Antigravity process not found');
    }
    const data = await antigravityRequest(info.connectPort, info.csrfToken, '/exa.language_server_pb.LanguageServerService/GetUserStatus', {
        metadata: {
            ideName: 'antigravity',
            extensionName: 'antigravity',
            locale: 'en'
        }
    });
    return parseAntigravityQuota(data);
}
async function refreshAntigravityQuota() {
    if (antigravityQuotaInFlight) {
        return antigravityQuotaInFlight;
    }
    antigravityQuotaInFlight = (async () => {
        try {
            const snapshot = await fetchAntigravityQuota();
            antigravityQuotaState = {
                status: 'ok',
                scope: 'active',
                fetchedAt: Date.now(),
                snapshot
            };
        }
        catch (err) {
            antigravityQuotaState = {
                status: 'error',
                scope: 'active',
                fetchedAt: Date.now(),
                error: String(err)
            };
        }
        finally {
            antigravityQuotaInFlight = null;
        }
        return antigravityQuotaState;
    })();
    return antigravityQuotaInFlight;
}
function scheduleSync() {
    if (syncTimer) {
        clearTimeout(syncTimer);
    }
    syncTimer = setTimeout(() => {
        runSync();
    }, SYNC_DEBOUNCE_MS);
}
function startAuthWatcher() {
    const authPath = getCodexAuthPath();
    fs.watchFile(authPath, { interval: SYNC_INTERVAL_MS }, () => {
        scheduleSync();
    });
}
export function startWebConsole(options) {
    const host = options?.host || DEFAULT_HOST;
    const port = options?.port || DEFAULT_PORT;
    if (!isWebHostAllowed(host)) {
        const err = Errors.localhostOnly(host);
        throw new Error(`${err.code}: ${err.message}`);
    }
    runSync();
    startAuthWatcher();
    const server = http.createServer(async (req, res) => {
        const requestUrl = new URL(req.url || '/', `http://${host}:${port}`);
        const path = requestUrl.pathname;
        try {
            if (req.method === 'GET' && path === '/') {
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(HTML);
                return;
            }
            if (req.method === 'GET' && path === '/api/state') {
                runSync();
                const store = loadStore();
                const rawAccounts = Object.values(store.accounts);
                const accounts = rawAccounts.map(scrubAccount);
                const deviceAlias = resolveAliasForCurrentAuth(store);
                const authSummary = getCodexAuthSummary();
                const storeStatus = getStoreStatus();
                // Phase G: Only load antigravity if feature is enabled
                const settings = getSettings();
                const runtimeSettings = getRuntimeSettings();
                const antigravityEnabled = settings.settings.featureFlags?.antigravityEnabled ?? false;
                const antigravity = antigravityEnabled ? loadAntigravityAccounts() : { accounts: [], path: ANTIGRAVITY_ACCOUNTS_FILE };
                const forceState = getForceState();
                const forceActive = isForceActive();
                sendJson(res, 200, {
                    authPath: getCodexAuthPath(),
                    deviceAlias,
                    rotationAlias: store.activeAlias,
                    accounts,
                    lastSyncAt,
                    lastSyncError,
                    lastSyncAlias,
                    authSummary,
                    storeStatus,
                    login: pendingLogin,
                    lastLoginError,
                    // Phase G: Only include antigravity data if feature is enabled
                    antigravity: antigravityEnabled ? { ...antigravity, quota: antigravityQuotaState } : { accounts: [], path: ANTIGRAVITY_ACCOUNTS_FILE, quota: { status: 'disabled', scope: 'active' } },
                    queue: getRefreshQueueState(),
                    recommendedAlias: recommendAlias(rawAccounts),
                    logPath: getLogPath(),
                    rotationStrategy: runtimeSettings.settings.rotationStrategy,
                    force: {
                        active: forceActive,
                        alias: forceState.forcedAlias,
                        forcedUntil: forceState.forcedUntil,
                        forcedBy: forceState.forcedBy,
                        remainingMs: getRemainingForceTimeMs(),
                        remainingTime: formatForceDuration(getRemainingForceTimeMs())
                    },
                    // Phase G: Include feature flags in state
                    featureFlags: settings.settings.featureFlags || { antigravityEnabled: false }
                });
                return;
            }
            if (req.method === 'GET' && path === '/api/logs') {
                const limitParam = requestUrl.searchParams.get('limit');
                const limit = limitParam ? Number(limitParam) : undefined;
                const lines = readLogTail(Number.isFinite(limit) ? limit : undefined);
                sendJson(res, 200, { path: getLogPath(), lines });
                return;
            }
            if (req.method === 'POST' && path === '/api/sync') {
                try {
                    runSync();
                    sendJson(res, 200, { ok: true });
                }
                catch (err) {
                    sendJson(res, 500, { error: String(err) });
                }
                return;
            }
            if (req.method === 'POST' && path === '/api/auth/start') {
                const body = await readJsonBody(req);
                const alias = typeof body.alias === 'string' ? body.alias.trim() : '';
                if (!alias) {
                    sendJson(res, 400, { error: 'Missing alias' });
                    return;
                }
                if (pendingLogin) {
                    sendJson(res, 409, { error: `Login already in progress for ${pendingLogin.alias}` });
                    return;
                }
                try {
                    const result = await startManualLogin(alias);
                    sendJson(res, 200, result);
                }
                catch (err) {
                    lastLoginError = String(err);
                    sendJson(res, 500, { error: String(err) });
                }
                return;
            }
            if (req.method === 'POST' && path === '/api/auth/callback') {
                const body = await readJsonBody(req);
                const callbackUrl = typeof body.callbackUrl === 'string' ? body.callbackUrl.trim() : '';
                if (!callbackUrl) {
                    sendJson(res, 400, { error: 'Missing callback URL' });
                    return;
                }
                if (!pendingLogin || pendingLogin.mode !== 'manual' || !pendingManualCallback) {
                    sendJson(res, 409, { error: 'No manual login is waiting for a callback' });
                    return;
                }
                try {
                    validateAuthorizationCallback(pendingManualCallback.flow, callbackUrl);
                    const submission = pendingManualCallback;
                    pendingManualCallback = null;
                    updatePendingLogin({
                        status: 'running',
                        step: 'Exchanging submitted authorization code...'
                    });
                    submission.resolve(callbackUrl);
                    sendJson(res, 202, { ok: true });
                }
                catch (err) {
                    sendJson(res, 400, { error: String(err instanceof Error ? err.message : err) });
                }
                return;
            }
            if (req.method === 'POST' && path === '/api/switch') {
                const body = await readJsonBody(req);
                if (!body.alias) {
                    sendJson(res, 400, { error: 'Missing alias' });
                    return;
                }
                try {
                    writeCodexAuthForAlias(body.alias);
                    sendJson(res, 200, { ok: true });
                }
                catch (err) {
                    sendJson(res, 400, { error: String(err) });
                }
                return;
            }
            if (req.method === 'POST' && path === '/api/remove') {
                const body = await readJsonBody(req);
                if (!body.alias) {
                    sendJson(res, 400, { error: 'Missing alias' });
                    return;
                }
                removeAccount(body.alias);
                sendJson(res, 200, { ok: true });
                return;
            }
            if (req.method === 'POST' && path === '/api/account/meta') {
                const body = await readJsonBody(req);
                if (!body.alias) {
                    sendJson(res, 400, { error: 'Missing alias' });
                    return;
                }
                const tags = typeof body.tags === 'string'
                    ? body.tags
                        .split(',')
                        .map((tag) => tag.trim().toLowerCase())
                        .filter(Boolean)
                    : [];
                const uniqueTags = Array.from(new Set(tags));
                const notes = typeof body.notes === 'string' ? body.notes.trim() : '';
                updateAccount(body.alias, {
                    tags: uniqueTags.length > 0 ? uniqueTags : undefined,
                    notes: notes || undefined
                });
                sendJson(res, 200, { ok: true });
                return;
            }
            if (req.method === 'POST' && path === '/api/token/refresh') {
                const body = await readJsonBody(req);
                const store = loadStore();
                const candidates = Object.values(store.accounts);
                const alias = typeof body.alias === 'string' ? body.alias : undefined;
                const targets = alias ? candidates.filter((acc) => acc.alias === alias) : candidates;
                if (alias && targets.length === 0) {
                    sendJson(res, 400, { error: 'Unknown alias' });
                    return;
                }
                const deviceAlias = resolveAliasForCurrentAuth(store);
                const results = [];
                for (const account of targets) {
                    if (!account.refreshToken) {
                        results.push({ alias: account.alias, updated: false, error: 'No refresh token' });
                        continue;
                    }
                    const refreshed = await refreshToken(account.alias);
                    if (!refreshed) {
                        results.push({ alias: account.alias, updated: false, error: 'Token refresh failed' });
                        continue;
                    }
                    if (deviceAlias === account.alias) {
                        try {
                            writeCodexAuthForAlias(account.alias);
                        }
                        catch (err) {
                            results.push({ alias: account.alias, updated: true, error: `Refreshed, but failed to update auth.json: ${err}` });
                            continue;
                        }
                    }
                    results.push({ alias: account.alias, updated: true });
                }
                sendJson(res, 200, { ok: true, results });
                return;
            }
            if (req.method === 'POST' && path === '/api/limits/refresh') {
                const body = await readJsonBody(req);
                const accounts = listAccounts().filter((acc) => acc.refreshToken && acc.accessToken);
                if (body.alias && !accounts.find((acc) => acc.alias === body.alias)) {
                    sendJson(res, 400, { error: 'Unknown alias' });
                    return;
                }
                const queue = startRefreshQueue(accounts, body.alias);
                sendJson(res, 200, { ok: true, queue });
                return;
            }
            if (req.method === 'POST' && path === '/api/limits/stop') {
                stopRefreshQueue();
                sendJson(res, 200, { ok: true });
                return;
            }
            // Phase G: Antigravity endpoints - check feature flag
            if (req.method === 'POST' && path === '/api/antigravity/refresh') {
                // Check if antigravity feature is enabled
                if (!isFeatureEnabled('antigravityEnabled')) {
                    sendJson(res, 403, {
                        error: 'Antigravity feature is disabled',
                        code: 'FEATURE_DISABLED',
                        feature: 'antigravity'
                    });
                    return;
                }
                await refreshAntigravityQuota();
                sendJson(res, 200, { ok: true, quota: antigravityQuotaState });
                return;
            }
            if (req.method === 'POST' && path === '/api/antigravity/refresh-all') {
                // Check if antigravity feature is enabled
                if (!isFeatureEnabled('antigravityEnabled')) {
                    sendJson(res, 403, {
                        error: 'Antigravity feature is disabled',
                        code: 'FEATURE_DISABLED',
                        feature: 'antigravity'
                    });
                    return;
                }
                await refreshAntigravityQuotaAll();
                sendJson(res, 200, { ok: true, quota: antigravityQuotaState });
                return;
            }
            // Phase D: Account Lifecycle API Endpoints
            // GET /api/accounts - List all accounts with metadata
            if (req.method === 'GET' && path === '/api/accounts') {
                const store = loadStore();
                const accounts = Object.values(store.accounts).map(acc => ({
                    alias: acc.alias,
                    email: acc.email,
                    enabled: acc.enabled !== false, // Defaults to true
                    disabledAt: acc.disabledAt,
                    disabledBy: acc.disabledBy,
                    disableReason: acc.disableReason,
                    usageCount: acc.usageCount,
                    rateLimits: acc.rateLimits,
                    limitsConfidence: acc.limitsConfidence,
                    limitStatus: acc.limitStatus,
                    limitError: acc.limitError,
                    lastLimitProbeAt: acc.lastLimitProbeAt,
                    lastLimitErrorAt: acc.lastLimitErrorAt,
                    tags: acc.tags,
                    notes: acc.notes
                }));
                sendJson(res, 200, { accounts });
                return;
            }
            // PUT /api/accounts/:alias/enabled - Enable/disable an account
            if (req.method === 'PUT' && path.startsWith('/api/accounts/') && path.endsWith('/enabled')) {
                const aliasMatch = path.match(/^\/api\/accounts\/([^\/]+)\/enabled$/);
                if (!aliasMatch) {
                    sendJson(res, 400, { error: 'Invalid path format' });
                    return;
                }
                const alias = aliasMatch[1];
                const store = loadStore();
                if (!store.accounts[alias]) {
                    sendJson(res, 404, { error: 'Unknown alias', code: 'ACCOUNT_NOT_FOUND' });
                    return;
                }
                const body = await readJsonBody(req);
                const enabled = body.enabled === true;
                // Phase D: Prevent disabling the last enabled account
                if (!enabled) {
                    const enabledCount = Object.values(store.accounts).filter(acc => acc.alias !== alias && acc.enabled !== false).length;
                    if (enabledCount === 0) {
                        sendJson(res, 409, {
                            error: 'Cannot disable the last enabled account',
                            code: 'LAST_ACCOUNT'
                        });
                        return;
                    }
                }
                // Phase D: Double-submit protection - check if already in desired state
                const currentEnabled = store.accounts[alias].enabled !== false;
                if (currentEnabled === enabled) {
                    sendJson(res, 409, {
                        error: enabled ? 'Account is already enabled' : 'Account is already disabled',
                        code: 'ALREADY_IN_STATE'
                    });
                    return;
                }
                const updates = { enabled };
                if (!enabled) {
                    updates.disabledAt = Date.now();
                    updates.disabledBy = 'dashboard'; // Could be expanded to track actor
                }
                else {
                    // Clear disable metadata when enabling
                    updates.disabledAt = undefined;
                    updates.disabledBy = undefined;
                    updates.disableReason = undefined;
                }
                updateAccount(alias, updates);
                logInfo(`Account ${alias} ${enabled ? 'enabled' : 'disabled'} via dashboard`);
                sendJson(res, 200, {
                    ok: true,
                    alias,
                    enabled,
                    disabledAt: updates.disabledAt,
                    disabledBy: updates.disabledBy
                });
                return;
            }
            // POST /api/accounts/:alias/reauth - Re-authenticate an account
            if (req.method === 'POST' && path.startsWith('/api/accounts/') && path.endsWith('/reauth')) {
                const aliasMatch = path.match(/^\/api\/accounts\/([^\/]+)\/reauth$/);
                if (!aliasMatch) {
                    sendJson(res, 400, { error: 'Invalid path format' });
                    return;
                }
                const alias = aliasMatch[1];
                const store = loadStore();
                if (!store.accounts[alias]) {
                    sendJson(res, 404, { error: 'Unknown alias', code: 'ACCOUNT_NOT_FOUND' });
                    return;
                }
                // Phase D: Cannot re-auth a disabled account
                if (store.accounts[alias].enabled === false) {
                    sendJson(res, 409, {
                        error: 'Cannot re-authenticate a disabled account',
                        code: 'ACCOUNT_DISABLED'
                    });
                    return;
                }
                // Phase D: Only targeted alias credentials mutate
                // Start OAuth flow for the specific alias
                try {
                    if (pendingLogin) {
                        sendJson(res, 409, { error: `Login already in progress for ${pendingLogin.alias}` });
                        return;
                    }
                    const result = await startManualLogin(alias);
                    sendJson(res, 200, {
                        ok: true,
                        alias,
                        url: result.url,
                        message: 'OAuth flow started. Complete authentication in the browser.'
                    });
                }
                catch (err) {
                    sendJson(res, 500, { error: String(err), code: 'AUTH_FLOW_ERROR' });
                }
                return;
            }
            // Phase E: Force Mode API endpoints
            // GET /api/force - Get current force state
            if (req.method === 'GET' && path === '/api/force') {
                const forceState = getForceState();
                const active = isForceActive();
                const remainingMs = getRemainingForceTimeMs();
                sendJson(res, 200, {
                    active,
                    alias: forceState.forcedAlias,
                    forcedAt: forceState.forcedAlias && forceState.forcedUntil
                        ? forceState.forcedUntil - (24 * 60 * 60 * 1000)
                        : null,
                    forcedUntil: forceState.forcedUntil,
                    forcedBy: forceState.forcedBy,
                    remainingMs,
                    remainingTime: formatForceDuration(remainingMs),
                    previousRotationStrategy: forceState.previousRotationStrategy
                });
                return;
            }
            // POST /api/force - Activate force mode for an alias
            if (req.method === 'POST' && path === '/api/force') {
                const body = await readJsonBody(req);
                const alias = typeof body.alias === 'string' ? body.alias.trim() : '';
                const actor = typeof body.actor === 'string' ? body.actor.trim() : 'api';
                if (!alias) {
                    sendJson(res, 400, { error: 'Missing alias', code: 'MISSING_ALIAS' });
                    return;
                }
                const result = activateForce(alias, actor);
                if (!result.success) {
                    const statusCode = result.error?.includes('not found') ? 404
                        : result.error?.includes('disabled') ? 409
                            : 400;
                    sendJson(res, statusCode, { error: result.error, code: 'FORCE_FAILED' });
                    return;
                }
                logInfo(`Force mode activated for ${alias} by ${actor}`);
                sendJson(res, 200, {
                    ok: true,
                    alias,
                    forcedUntil: result.state?.forcedUntil,
                    remainingMs: result.state?.forcedUntil ? result.state.forcedUntil - Date.now() : 0,
                    remainingTime: result.state?.forcedUntil
                        ? formatForceDuration(result.state.forcedUntil - Date.now())
                        : '0m',
                    previousRotationStrategy: result.state?.previousRotationStrategy
                });
                return;
            }
            // POST /api/force/clear - Deactivate force mode
            if (req.method === 'POST' && path === '/api/force/clear') {
                const result = clearForce();
                if (result.success) {
                    logInfo('Force mode cleared');
                    sendJson(res, 200, {
                        ok: true,
                        restoredStrategy: result.restoredStrategy
                    });
                }
                else {
                    sendJson(res, 500, { error: 'Failed to clear force mode', code: 'CLEAR_FAILED' });
                }
                return;
            }
            // Phase F: Settings API Endpoints
            // GET /api/settings - Get current settings
            if (req.method === 'GET' && path === '/api/settings') {
                const { getSettingsWithInfo } = await import('./settings.js');
                const info = getSettingsWithInfo();
                sendJson(res, 200, {
                    settings: info.settings,
                    source: info.source,
                    preset: info.preset,
                    canReset: info.canReset
                });
                return;
            }
            // PUT /api/settings - Update settings
            if (req.method === 'PUT' && path === '/api/settings') {
                const body = await readJsonBody(req);
                const { updateSettings } = await import('./settings.js');
                const actor = body.actor || 'dashboard';
                const updates = {};
                if (body.rotationStrategy) {
                    updates.rotationStrategy = body.rotationStrategy;
                }
                if (typeof body.criticalThreshold === 'number') {
                    updates.criticalThreshold = body.criticalThreshold;
                }
                if (typeof body.lowThreshold === 'number') {
                    updates.lowThreshold = body.lowThreshold;
                }
                if (body.accountWeights) {
                    updates.accountWeights = body.accountWeights;
                }
                // Phase G: Handle feature flags
                if (body.featureFlags && typeof body.featureFlags === 'object') {
                    updates.featureFlags = body.featureFlags;
                }
                const result = updateSettings(updates, actor);
                if (result.success) {
                    sendJson(res, 200, {
                        ok: true,
                        settings: result.settings
                    });
                }
                else {
                    sendJson(res, 400, {
                        error: 'Validation failed',
                        code: 'VALIDATION_ERROR',
                        details: result.errors
                    });
                }
                return;
            }
            // Phase G: GET /api/settings/feature-flags - Get feature flags
            if (req.method === 'GET' && path === '/api/settings/feature-flags') {
                const settings = getSettings();
                sendJson(res, 200, {
                    featureFlags: settings.settings.featureFlags || { antigravityEnabled: false }
                });
                return;
            }
            // Phase G: PUT /api/settings/feature-flags - Update feature flags
            if (req.method === 'PUT' && path === '/api/settings/feature-flags') {
                const body = await readJsonBody(req);
                const { updateSettings } = await import('./settings.js');
                const actor = body.actor || 'dashboard';
                const updates = {};
                if (body.featureFlags && typeof body.featureFlags === 'object') {
                    updates.featureFlags = body.featureFlags;
                    const result = updateSettings(updates, actor);
                    if (result.success && result.settings) {
                        logInfo(`Feature flags updated by ${actor}: ${JSON.stringify(body.featureFlags)}`);
                        sendJson(res, 200, {
                            ok: true,
                            featureFlags: result.settings.featureFlags || { antigravityEnabled: false }
                        });
                    }
                    else {
                        sendJson(res, 400, {
                            error: 'Validation failed',
                            code: 'VALIDATION_ERROR',
                            details: result.errors
                        });
                    }
                }
                else {
                    sendJson(res, 400, {
                        error: 'Invalid feature flags',
                        code: 'INVALID_FEATURE_FLAGS'
                    });
                }
                return;
            }
            // POST /api/settings/reset - Reset to defaults
            if (req.method === 'POST' && path === '/api/settings/reset') {
                const { resetSettings } = await import('./settings.js');
                const body = await readJsonBody(req);
                const actor = body.actor || 'dashboard';
                const settings = resetSettings(actor);
                sendJson(res, 200, {
                    ok: true,
                    settings
                });
                return;
            }
            // POST /api/settings/preset - Apply a preset
            if (req.method === 'POST' && path === '/api/settings/preset') {
                const body = await readJsonBody(req);
                const { applyPreset } = await import('./settings.js');
                const preset = body.preset;
                if (!preset || !['balanced', 'conservative', 'aggressive', 'custom'].includes(preset)) {
                    sendJson(res, 400, {
                        error: 'Invalid preset',
                        code: 'INVALID_PRESET',
                        validPresets: ['balanced', 'conservative', 'aggressive', 'custom']
                    });
                    return;
                }
                const actor = body.actor || 'dashboard';
                const result = applyPreset(preset, actor);
                if (result.success) {
                    sendJson(res, 200, {
                        ok: true,
                        preset,
                        settings: result.settings
                    });
                }
                else {
                    sendJson(res, 400, {
                        error: 'Failed to apply preset',
                        code: 'PRESET_ERROR',
                        details: result.errors
                    });
                }
                return;
            }
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Not found' }));
        }
        catch (err) {
            if (res.writableEnded) {
                return;
            }
            const errorCode = err?.code;
            if (errorCode === 'INVALID_JSON') {
                sendJson(res, 400, { error: 'Invalid JSON payload', code: 'INVALID_JSON' });
                return;
            }
            if (errorCode === 'PAYLOAD_TOO_LARGE') {
                sendJson(res, 413, { error: 'Payload too large', code: 'PAYLOAD_TOO_LARGE' });
                return;
            }
            const errorMessage = err instanceof Error ? err.message : String(err);
            logError(`Web request failed (${req.method} ${path}): ${errorMessage}`);
            sendJson(res, 500, { error: 'Internal server error', code: 'INTERNAL_ERROR' });
        }
    });
    server.listen(port, host, () => {
        console.log(`[multi-auth] Codex dashboard running at http://${host}:${port}`);
        logInfo(`Codex dashboard running at http://${host}:${port}`);
    });
    return server;
}
//# sourceMappingURL=web.js.map