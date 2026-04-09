# Capy CLI

[![CI](https://github.com/capysc/capy/actions/workflows/ci.yml/badge.svg)](https://github.com/capysc/capy/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/capysc/capy/branch/main/graph/badge.svg)](https://codecov.io/gh/capysc/capy)
[![npm](https://img.shields.io/npm/v/@capy/cli)](https://www.npmjs.com/package/@capy/cli)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue)](https://www.typescriptlang.org)
[![License](https://img.shields.io/badge/license-BUSL--1.1-blue)](./LICENSE)

> Secret Ops for people with better things to do

A zero-trust command-line tool for secure environment variable management with seamless team collaboration through intelligent sync capabilities.

## Quick Start

```bash
# Install globally
npm install -g @capy/cli

# Run in any project directory
capy
```

That's it! The CLI intelligently handles initialization, authentication, and sync based on your project state.

## Installation

### Global Installation (Recommended)

```bash
npm install -g @capy/cli
```

### Requirements

- Node.js v18 or higher
- bun
- Git (for automatic `.gitignore` management)
- WorkOS organization access (for team features)

For local development setup, see the [root README](../../README.md#local-development).

## Usage

### First-Time Project Setup

When you run `capy` in a directory without a `keep.lock` file:

```bash
$ capy
⚠ No project configuration found
🔐 Authenticating with WorkOS...
✓ Authenticated as john@company.com (Acme Corp)

📁 Project name (default: "my-app"): customer-api
✓ Project "customer-api" created
✓ Generated secure encryption keys
✓ Ready to sync environment variables!
```

### Team Member Onboarding

New team members just need to clone and run:

```bash
$ git clone https://github.com/acme/customer-api
$ cd customer-api
$ capy
📁 Project: customer-api (Acme Corp)
🔐 Authenticating with WorkOS...
✓ Authenticated as sarah@company.com
✓ Retrieved your .env file (5 variables)
✓ Created local .env with your variables
✓ Ready to work!
```

### Daily Development Flow

Add new variables to `.env` and sync:

```bash
$ capy
✓ Authenticated as john@company.com
✓ Retrieved remote .env (3 variables)

⚠ Found 2 new local variables:
┌─────────────────┬──────────────────────┐
│ Variable        │ Value                │
├─────────────────┼──────────────────────┤
│ NEW_API_KEY     │ sk-1234...           │
│ DEBUG_MODE      │ true                 │
└─────────────────┴──────────────────────┘

? NEW_API_KEY: Push to capy? (y/N) y
? DEBUG_MODE: Push to capy? (y/N) n

✓ Pushed NEW_API_KEY to keep
✓ Kept DEBUG_MODE local only
✓ Updated .env with 4 total variables
```

### Handling Conflicts

When local and remote values differ:

```bash
$ capy
✓ Retrieved remote .env (3 variables)

⚠ Found conflicts:
┌─────────────────┬──────────────────────┬──────────────────────┐
│ Variable        │ Local Value          │ Remote Value         │
├─────────────────┼──────────────────────┼──────────────────────┤
│ DATABASE_URL    │ postgres://local...  │ postgres://prod...   │
└─────────────────┴──────────────────────┴──────────────────────┘

? DATABASE_URL conflict resolution:
  → Use local value (postgres://localhost:5432/dev)
    Use remote value (postgres://prod.example.com:5432/app)

✓ Keeping local DATABASE_URL value
```

## Command Options

```bash
capy [options]
```

### Options

- `--env-path <path>` - Specify custom .env file location (default: `./.env`)
- `--verbose` - Enable detailed logging
- `--dry-run` - Preview changes without applying
- `--force` - Re-encrypt existing variables
- `--help` - Show help information
- `--version` - Show version number

### Examples

```bash
# Use custom .env file location
capy --env-path ./config/.env

# Preview what would happen without making changes
capy --dry-run

# Enable detailed logging for debugging
capy --verbose

# Force re-encryption of all variables
capy --force
```


## Project Files

The CLI creates and manages these files:

- **`.env`** - Your plaintext environment variables (gitignored)
- **`keep.lock`** - Project metadata only, no secrets (committed to git)
- **`.decrypt`** - User-specific decryption key (gitignored)
- **`.gitignore`** - Automatically updated to exclude secrets

Only `keep.lock` is committed to version control - it contains no secrets, just project metadata.

## Security Model

### Zero-Trust Architecture

- **No Master Key Storage**: Keys derived temporarily, discarded immediately
- **HSM-Backed Storage**: Individual secrets in AWS KMS with hardware security
- **Organization Isolation**: Unique salt prevents cross-org key derivation
- **Session-Based Revocation**: Cut off access instantly via session invalidation
- **No Plaintext Persistence**: Service never stores plaintext values

### What Gets Stored Where

| Location | What's Stored | Committed to Git |
|----------|---------------|------------------|
| `.env` | Plaintext secrets | ❌ Never |
| `keep.lock` | Project metadata only | ✅ Always |
| `.decrypt` | User-specific key | ❌ Never |
| Capy Service | Encrypted secrets in KMS | N/A |

## Troubleshooting

### Authentication Issues

```bash
❌ Authentication failed: Organization access required
```

**Solution**: Ensure your WorkOS account has access to the organization. Contact your admin if needed.

### Permission Errors

```bash
❌ Permission denied writing to .decrypt file
```

**Solution**: Fix file permissions:
```bash
chmod 755 .
chmod 600 .decrypt
```

### No .env File

```bash
❌ No .env file found in current directory
```

**Solution**: Create an .env file or specify a custom path:
```bash
touch .env
# or
capy --env-path ./config/.env
```

### Connection Issues

```bash
❌ Failed to connect to Capy service
```

**Solution**: Check your internet connection and verify the service is running.

### OAuth Browser Issues

If the browser doesn't open automatically during authentication:

1. Copy the URL from the terminal output
2. Paste it into your browser manually
3. Complete the authentication flow

## Environment Variables

Configure CLI behavior with these environment variables:

- `CAPY_API_URL` - Override default API endpoint
- `CAPY_AUTH_TIMEOUT` - OAuth timeout in seconds (default: 300)
- `CAPY_LOG_LEVEL` - Logging verbosity (error, warn, info, debug)

Example:
```bash
export CAPY_API_URL=https://api.capy.sc
export CAPY_LOG_LEVEL=debug
capy
```

## Contributing

Contributions welcome! Please read our [Contributing Guide](../../CONTRIBUTING.md) for details.

### Development Process

1. Fork the repository
2. Create a feature branch
3. Make your changes with tests
4. Run `npm test` and `npm run typecheck`
5. Submit a pull request

## Support

- **Issues**: [GitHub Issues](https://github.com/capysc/capy-cli/issues)
- **Documentation**: [docs.capy.sc](https://docs.capy.sc)
- **Discord**: [Join our community](https://discord.gg/capy)

## License

Business Source License 1.1 - see [LICENSE](./LICENSE) for details.