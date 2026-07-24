#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { loginAccount } from './auth.js';
import { removeAccount, listAccounts, getStorePath, loadStore } from './store.js';
import { startWebConsole } from './web.js';
import { startApiServer } from './api-server.js';
import { disableService, installService, serviceStatus } from './systemd.js';
const args = process.argv.slice(2);
const command = args[0];
const alias = args[1];
function getFlagValue(flag) {
    const idx = args.indexOf(flag);
    if (idx === -1)
        return undefined;
    return args[idx + 1];
}
async function main() {
    switch (command) {
        case 'add':
        case 'login': {
            if (!alias) {
                console.error('Usage: opencode-multi-auth add <alias>');
                console.error('Example: opencode-multi-auth add work');
                process.exit(1);
            }
            try {
                const account = await loginAccount(alias);
                console.log(`\nAccount "${alias}" added successfully!`);
                console.log(`Email: ${account.email || 'unknown'}`);
            }
            catch (err) {
                console.error(`Failed to add account: ${err}`);
                process.exit(1);
            }
            break;
        }
        case 'remove':
        case 'rm': {
            if (!alias) {
                console.error('Usage: opencode-multi-auth remove <alias>');
                process.exit(1);
            }
            removeAccount(alias);
            console.log(`Account "${alias}" removed.`);
            break;
        }
        case 'list':
        case 'ls': {
            const accounts = listAccounts();
            if (accounts.length === 0) {
                console.log('No accounts configured.');
                console.log('Add one with: opencode-multi-auth add <alias>');
            }
            else {
                console.log('\nConfigured accounts:\n');
                for (const acc of accounts) {
                    console.log(`  ${acc.alias}: ${acc.email || 'unknown email'} (uses: ${acc.usageCount})`);
                }
                console.log();
            }
            break;
        }
        case 'status': {
            const store = loadStore();
            const accounts = Object.values(store.accounts);
            console.log('\n[multi-auth] Account Status\n');
            console.log('Strategy: round-robin');
            console.log(`Accounts: ${accounts.length}`);
            console.log(`Active: ${store.activeAlias || 'none'}\n`);
            if (accounts.length === 0) {
                console.log('No accounts configured. Run: opencode-multi-auth add <alias>\n');
                return;
            }
            for (const acc of accounts) {
                const isActive = acc.alias === store.activeAlias ? ' (active)' : '';
                const isRateLimited = acc.rateLimitedUntil && acc.rateLimitedUntil > Date.now()
                    ? ` [RATE LIMITED until ${new Date(acc.rateLimitedUntil).toLocaleTimeString()}]`
                    : '';
                const expiry = new Date(acc.expiresAt).toLocaleString();
                console.log(`  ${acc.alias}${isActive}${isRateLimited}`);
                console.log(`    Email: ${acc.email || 'unknown'}`);
                console.log(`    Uses: ${acc.usageCount}`);
                console.log(`    Token expires: ${expiry}`);
                console.log();
            }
            break;
        }
        case 'path': {
            console.log(getStorePath());
            break;
        }
        case 'web': {
            const portArg = getFlagValue('--port');
            const hostArg = getFlagValue('--host');
            const port = portArg ? Number(portArg) : undefined;
            if (portArg && Number.isNaN(port)) {
                console.error('Invalid --port value');
                process.exit(1);
            }
            startWebConsole({ port, host: hostArg });
            break;
        }
        case 'api':
        case 'serve': {
            const portArg = getFlagValue('--port');
            const hostArg = getFlagValue('--host');
            const port = portArg ? Number(portArg) : undefined;
            if (portArg && Number.isNaN(port)) {
                console.error('Invalid --port value');
                process.exit(1);
            }
            startApiServer({ port, host: hostArg });
            break;
        }
        case 'service': {
            const action = args[1] || 'status';
            const portArg = getFlagValue('--port');
            const hostArg = getFlagValue('--host');
            const port = portArg ? Number(portArg) : undefined;
            if (portArg && Number.isNaN(port)) {
                console.error('Invalid --port value');
                process.exit(1);
            }
            const cliPath = fileURLToPath(import.meta.url);
            if (action === 'install') {
                const file = installService({ cliPath, host: hostArg, port });
                console.log(`Installed systemd user service at ${file}`);
                break;
            }
            if (action === 'disable') {
                disableService();
                console.log('Disabled codex-soft systemd user service.');
                break;
            }
            serviceStatus();
            break;
        }
        case 'help':
        case '--help':
        case '-h':
        default: {
            console.log(`
opencode-multi-auth - Multi-account OAuth rotation for OpenAI Codex

Commands:
  add <alias>      Add a new account (opens browser for OAuth)
  remove <alias>   Remove an account
  list             List all configured accounts
  status           Show detailed account status
  path             Show config file location
  web              Launch local Codex auth.json dashboard (use --port/--host)
  api              Launch OpenAI-compatible multi-auth API (use --port/--host)
  service          Install/disable systemd user service (install|disable|status)
  help             Show this help message

Examples:
  opencode-multi-auth add personal
  opencode-multi-auth add work
  opencode-multi-auth add backup
  opencode-multi-auth status
  opencode-multi-auth web --port 3434 --host 127.0.0.1
  opencode-multi-auth api --port 3435 --host 127.0.0.1
  opencode-multi-auth service install --port 3434 --host 127.0.0.1

After adding accounts, the plugin auto-rotates between them.
`);
            break;
        }
    }
}
main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
//# sourceMappingURL=cli.js.map