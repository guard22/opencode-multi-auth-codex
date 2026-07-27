# Contributing

Thanks for helping improve opencode-multi-auth-codex.

## Before opening an issue

- Search existing issues and pull requests.
- Include your OpenCode version, Node.js version, operating system, and install
  method.
- Remove account names, email addresses, tokens, cookies, and screenshots that
  contain private information.
- Provide the smallest reproducible example you can.

## Pull requests

Keep pull requests focused on one problem. A strong pull request includes:

- a concise description of the problem and intended behavior
- tests for behavior changes
- documentation updates for user-facing changes
- `npm run lint` and the relevant test suites passing locally

Start with an issue before proposing a large feature or architectural change.

## Development

```bash
npm ci
npm run lint
npm test
npm run build
```

The project supports Node.js 20 and newer.

## Responsible use

Contributions must not add credential theft, account sharing, disposable
account provisioning, provider enforcement evasion, or collection of secrets.
Use only accounts you own or are authorized to operate, and follow the terms
and policies of every service you connect.
