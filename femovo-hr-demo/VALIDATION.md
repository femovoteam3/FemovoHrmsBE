# Local verification — 9 November 2026

## Confirmed

- `npm test`: 86 tests passed; none failed or skipped. Database calls are stubbed. Tests cover the real Express authorization chain, retired payroll routes, record isolation, revocation, capability upload rejection, effective permission overrides, API-origin restrictions, configuration, money validation, CSV escaping, file signatures, transaction/audit ordering, leave reversals, onboarding, helpdesk, performance, and training. Training coverage includes YouTube URL validation, canonical video storage, server-side scoring, hidden answer keys, course assignments, and team scope.
- Every top-level `server/*.js` file and the integration test file passed `node --check`.
- `npm run build` completed successfully after the frontend changes. Feature modules are split into separate bundles.
- Migration `011_remove_payroll_permissions.sql` was applied to the configured database. It removed 44 obsolete permission rows and the unused payroll role while preserving 1 historical payroll run and 16 salary records. No migrations remain pending.
- Migration `013_training_integrity.sql` was applied to the configured database. All five training integrity constraints are active and no migrations remain pending.

## Recruitment workflow upgrade (migration 016)

- `npm test`: 115 tests passed. New coverage: stage rules and the interview evidence each move needs, per-role move permissions, HR Assistant assignment order (job, role, department, primary owner, workload), default permissions per role, role-aware Home steps.
- `npm run test:integration` on a disposable local PostgreSQL: 26 tests passed. `tests/integration/workflow.test.js` drives the API as Super Admin, CEO, Head HR, two HR Assistants and an Interviewer through application to EMS onboarding, an additional interviewer round, CEO rejection, CEO-requested interview and automatic return, offer decline and re-issue, permission switches, deactivation with reassignment, notifications, and refusal of another assistant's candidate on every route.
- Migration `016_recruitment_workflow.sql` was rehearsed on a disposable database holding every earlier stage name: stages were renamed with waiting time kept, single interviews became interview records, and unenforced permission rows were removed.
- Browser click-through on a disposable database as HR Assistant, Head HR, CEO, Interviewer and Super Admin: screening call, HR L1 scorecard, Head HR round, recommendation, CEO approval and interview request, offer issue/accept, onboarding, assignments, job form, Add Candidate and public apply link.
- Not exercised in a browser: CSV import, offer decline/withdraw buttons, CEO interview scheduling, mobile layouts of the new pages. These paths are covered by API tests only where listed above.
- Migration 016 was applied to the configured database after a backup. Migration `017_application_details.sql` (public application form fields) was also applied to the configured database after a backup; the public job list was read back from the restarted server. No application was submitted to the configured database.

## Not verified

- The isolated PostgreSQL integration suite, concurrency testing, and browser workflows. The suite is skipped when `TEST_DATABASE_URL` is not configured. Its synthetic database guard must remain enabled.
- Dependency vulnerability auditing: registry access was unavailable during the earlier audit attempt. Existing package versions have not been certified vulnerability-free.
- Production deployment, backups/restores, load testing, infrastructure encryption, malware scanning, and legal compliance.

## Required before release

Follow `OPERATIONS.md`: supply a new JWT secret and database configuration, back up and rehearse migrations in staging, reconcile legacy leave data, rotate exposed/default credentials, configure the approved calendar, and complete the database and browser checks. Newly provisioned candidate/resource accounts require an administrator to set their initial password.

No credential rotations or deployment were performed. The existing environment file was preserved; startup intentionally fails if required security configuration or migrations are missing. The code changes are not a claim that every possible defect has been eliminated.
