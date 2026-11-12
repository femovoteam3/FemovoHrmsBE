# FEMOVO People Suite

React/Vite frontend, Express API, and PostgreSQL for employee management and recruitment.

The application is undergoing security and correctness hardening. It is not yet certified for production, payroll compliance, or processing real identity documents.

## Development

1. Run `npm ci` and `npm --prefix client ci`.
2. Configure `server/.env` using `server/.env.example`. A random JWT secret is mandatory.
3. Read [OPERATIONS.md](OPERATIONS.md), back up any existing database, and review the versioned migrations before running `npm run migrate`.
4. For a new empty installation, create the first administrator with `npm run bootstrap:admin` and environment-supplied credentials. There is no default PIN or public administrator login.
5. Start the API with `npm run dev:server` and the frontend with `npm run dev:client`.

## Verification

- `npm test`: offline regression suite, including real Express route chains with a stubbed database.
- `npm run check`: backend syntax checks.
- `npm run build`: frontend production build.
- `npm run test:integration`: isolated PostgreSQL integration tests; requires the guarded test database described in the runbook. Skipped tests are not evidence of passing integration.

## Current safeguards

Server-side route and record authorization; account/session revocation; one-way password hashes; private document downloads; candidate-specific expiring upload capabilities; validated PDF/image uploads; transactional mutation audits; leave duration and reversal handling; separate payroll calculation, approval, and payment confirmation.

Payroll requires an explicitly configured and approved calendar/policy. It does not calculate statutory deductions automatically. Existing payroll and legacy leave records are retained and require reconciliation where the old data is ambiguous.

See [OPERATIONS.md](OPERATIONS.md) for migration, deployment, rollback, privacy, backup/restore, and release-gate instructions. CI is defined in `.github/workflows/ci.yml` at the Git repository root.
