# FEMOVO deployment and migration runbook

Do not treat successful compilation or mocked-database tests as production certification. Record each environment's migration and deployment state separately from this runbook.

## Release gates

1. Complete the isolated PostgreSQL integration suite and browser smoke tests.
2. Back up the database and private uploads together; restore them to an isolated environment and verify employee/document references.
3. Review migration results, retained historical payroll records, and legacy leave balances.
4. Configure secrets, TLS, private persistent file storage, and the working calendar.
5. Rotate every previously exposed/default password and the old JWT signing secret. Removing source literals alone does not rotate an operational credential.
6. Have legal/privacy specialists review the business rules and public claims described below.

## Installation

Use Node.js 24 and PostgreSQL. Install root dependencies with `npm ci` and frontend dependencies with `npm --prefix client ci`. Runtime imports can resolve root dependencies; a second server installation is unnecessary.

Copy `server/.env.example` to `server/.env`, or inject environment variables through the deployment secret store. Existing environment variables take precedence. Configuration is loaded from the server directory regardless of the command's current directory.

Generate a random JWT secret. Production requires an explicit CORS allowlist and `PGSSL=true`; database certificates are verified. Set a trusted root certificate path for private CAs. Database-URL SSL query parameters are deliberately ignored so they cannot disable certificate validation. Do not commit `.env` or private uploads.

Build using `npm run build`. After the migration steps below, `npm start` serves the API and the built frontend. For local development, run `npm run dev:server` and `npm run dev:client` separately. Configure `client/.env.production` with `VITE_API_BASE_URL` when hosting the frontend separately. The frontend deployment needs its own matching CSP and SPA routing configuration. Requests attach credentials only to the configured API origin.

## Migrating an existing database

Review SQL in `server/migrations/` before executing `npm run migrate` with a migration-specific database role. Migrations run under one transaction and an advisory lock. The application no longer creates databases or rewrites seeded users at startup.

- `001_schema.sql`: existing schema definitions, without demo records or credential resets.
- `002_security.sql`: session versions, upload capabilities, fractional leave balances, payroll batches, and indexes.
- `003_integrity.sql`: session-revocation triggers, append-only audit trigger, fractional attendance, and a constraint prohibiting plaintext password copies. The runner hashes existing plaintext passwords before applying this migration; existing hashes and account status are preserved.
- `004_pipeline_stages.sql`: widens the applicant stage column and renames legacy stages to the current pipeline.
- `005_pipeline_updates.sql`: adds applicant monthly salary and remarks.
- `006_helpdesk_posh.sql`: adds ICC membership and POSH complaint fields, marks every POSH record confidential, and maps old ticket statuses to the simplified ones.
- `007_team_helpdesk.sql`: adds Team Helpdesk recipients and conversation messages. Conversations addressed to the CEO or a team head are visible only to the sender and that person; the HR inbox is shared with HR and administrators.
- `008_performance_goals.sql`: adds quarterly goals, progress updates and comments, and records the quarter on reviews. Earlier reviews are retained.
- `009_onboarding_verification.sql`: revokes legacy onboarding approvals when the form was not submitted or one of the five required document types is missing. The affected profiles return to HR review without deleting personal details or uploaded files.
- `010_training_courses.sql`: moves the four standard courses into the database and adds assignments and a training record for each person. The old shared completion flag is no longer used, because it cannot be attributed to anyone.
- `011_remove_payroll_permissions.sql`: removes obsolete payroll permissions after retirement of the payroll API. Historical salary and payroll records are retained.
- `013_training_integrity.sql`: links training progress to employees and validates lesson/question JSON, assignment targets, attempts, and score ranges.
- `012_applicant_stage_time.sql`: records when each candidate entered their current stage, so ATS Home can flag anyone waiting too long. Existing candidates start from their application date.
- `014_recruiter_names.sql`: replaces job titles stored in the recruiter name fields with the recruiter's real name.
- `015_simple_stages.sql`: renames candidates into the five stages (New, Screening, HR L1, HR Round, Selected) without resetting their days in stage, restricts the column to those stages plus Rejected, and links candidates to jobs by id. Candidates in "Confirm to Select" return to HR Round. Candidates whose job title matches no job keep a null link.
- `016_recruitment_workflow.sql`: the eight-step recruitment workflow. Renames `HR Round` to `Head HR Round` and `Selected` to `Approved` without resetting days in stage (candidates selected before the CEO step existed count as CEO-approved), and adds interview records, candidate history, offers, in-app notifications and HR Assistant assignment rules. Each active HR Assistant starts with a rule for the department already on their record; no candidate is reassigned. Permission rows the server never enforced are deleted.
- `017_application_details.sql`: adds qualification, current city and profile link to candidates for the public application form. Existing candidates keep empty values.

The server refuses to start, and `/api/ready` returns 503, while any migration file in `server/migrations/` has not been applied.

## Recruitment workflow

The board has five stages: New, Screening, HR L1, Head HR Round, CEO Approval. A CEO decision moves a candidate to Approved (ready for offer) or Rejected (archived). A candidate can leave a stage only when the interview for that stage is completed: the screening call, an HR L1 scorecard that recommends hiring, and the Head HR scorecard. A required additional interview blocks the next move until it is completed. An offer needs CEO approval; onboarding to EMS needs an accepted offer.

Business roles are stored in `user_accounts.ats_role`: `ceo`, `rec_lead` (Head HR), `rec_associate` (HR Assistant) and `hiring_manager` (Interviewer). Super Admin keeps every permission. No CEO account is created by the migration: add one in Talent Resources as Super Admin, then set its password through the credential reset flow. Until then only Super Admin can give final approval. Nobody can add or change a person at their own role level or above.

New candidates are owned by, in order: the HR Assistant named on the job (or its backup), an assignment for that job, for that job title, then for that department. A primary owner wins, then the lightest workload. With nobody eligible the candidate waits in the Unassigned queue and Head HR and the CEO are notified. Changing assignments never moves existing candidates; use reassignment. A deactivated HR Assistant keeps their candidates until someone reassigns them, and they stay hidden from other HR Assistants.

The public application form (`/?apply=all`, or `/?apply=<job id>` for one job) requires name, email, mobile number, experience and consent. Salary, notice period, qualification, city, profile link and resume are optional and are saved only when the applicant gives them. Resumes must be PDF, PNG or JPG up to 10 MB. One open application is accepted per email address and job. The consent wording on the form should be reviewed with the privacy notice described below.

Notifications are in-app only. The app does not send email or WhatsApp messages by itself and does not create meeting links: invitations are copied or opened in WhatsApp by the user, and Google Meet links are pasted in.

Migrations remove readable password copies from the database. Existing encrypted backups may still contain them; restrict and retire those backups under an approved retention policy. Migration rollback does not erase secrets from historical backups.

Historical payroll records and salary structures are retained for audit and candidate-promotion compatibility. The application no longer exposes payroll calculation, approval, payment, salary-management, or bank-export APIs. Do not delete historical records without a separately reviewed retention and migration plan.

Existing approved leave records are marked unreconciled. Because the old application deducted one day regardless of duration and did not track reversals, their true balances cannot be inferred safely. Reconcile them in staging, document the authoritative balance, deducted amount, and balance category, then update the approved records through a reviewed administrator migration before reversing them. Pending legacy leave can be approved using the new calculation. No balances are automatically fabricated.

Uploaded files remain at their existing paths and retain their database references. Requests now require authentication and record authorization. Deleting a document record removes its application access but retains the physical orphan for reviewed retention and recovery. Define and test an orphan cleanup process with a retention period before enabling scheduled deletion.

For a fresh installation only, run `npm run bootstrap:admin` with `BOOTSTRAP_EMAIL` and a random 12–72 byte `BOOTSTRAP_PASSWORD` supplied through the environment. Bootstrap refuses to overwrite an existing administrator. Remove those variables after use. Administrators reset accounts through the application; existing passwords cannot be viewed.

Candidate promotions and newly created platform/recruitment resources provision an account with a random, undisclosed password hash. An administrator must set an initial password through the credential reset endpoint before the person can sign in and deliver it through an approved secure channel. Promotion preserves the supplied joining date and does not assign a fabricated manager. Existing accounts are not automatically recreated or reactivated by migrations.

## Business rules requiring configuration

`WORK_WEEK` is a comma-separated set of weekday numbers (Sunday 0). `HOLIDAYS_JSON` is a JSON array of `YYYY-MM-DD` dates, including `[]` when the reviewed calendar has none. The business timezone defaults to Asia/Kolkata. Review state/location-specific calendars before use.

Resubmitting an onboarding profile or uploading/deleting a document clears the profile review so changed details must be reviewed again. No example account numbers are substituted.

Training videos accept HTTPS YouTube links only. The server stores a canonical video ID, and the frontend embeds videos from YouTube's privacy-enhanced domain. Loading a video still makes a request to YouTube, so employee privacy notices and network policy should cover that third-party service.

## Tests

`npm test` runs calculations, validation, Express authorization with a stubbed database, API-origin checks, and transaction/audit response tests. `npm run check` checks backend syntax. `npm run build` builds the frontend.

The integration suite intentionally permits only `localhost` or `127.0.0.1`, port `55439`, database `femovo_security_test`. It drops and recreates the public schema in that disposable database. Never remove its URL guard to target an operational database.

Set `TEST_DATABASE_URL` for that dedicated database and run `npm run test:integration`. The suite verifies migrations on synthetic legacy accounts, retired payroll routes, HTTP authorization, upload ownership, revocation, concurrent leave decisions, half-days, and audit protection. It reports skipped when no test database URL is configured; a skip is not a pass.

CI is defined in `.github/workflows/ci.yml` at the Git repository root and runs on GitHub once that file is pushed.

Browser smoke-test checklist: login/logout/session expiry; employee versus administrator navigation; creating/editing an employee; own onboarding upload and private download; public application upload failure/retry; leave failure messages; CSV downloads on same-origin and separate-origin hosting; dialog focus, Escape, keyboard navigation, and mobile layouts.

## Deployment controls and recovery

Use separate migration and runtime database roles. Runtime needs only the necessary SELECT/INSERT/UPDATE/DELETE and sequence privileges; it must not own schema objects or have DDL/superuser access. Audit history is append-only through the trigger, but privileged database operators can alter triggers. Do not describe this as cryptographically immutable storage.

Persist and encrypt the database, document volume, and backups through the infrastructure provider. The code does not configure infrastructure encryption, malware scanning, external monitoring, or shared rate-limit storage. The current rate limiter is process-local; use a shared edge/gateway limit before running multiple API replicas. Configure proxy hops accurately.

Monitor `/api/health` and `/api/ready`, error rates, authentication failures, database availability, storage capacity, backups, and restore checks. Handle SIGTERM with the included graceful shutdown. No deployment pipeline or live infrastructure was changed.

For rollback, restore a tested compatible application/database pair using the backup procedure. Do not redeploy the old insecure application over a database containing the new credential constraints. Rehearse rollback in staging before release. Decide recovery point/time objectives with the business owner.

## Privacy and professional review

Inventory and justify collection of identity numbers, identity documents, bank details, health-related leave, emergency contacts, and grievances. Define role access, retention, employee/candidate notices, access/export/deletion handling, incident response, and backup retention. POSH complaints are readable only by people a super admin has named as ICC members, and audit entries for them omit the person's name. A super admin can add themselves, which is recorded in the audit log, and privileged database operators can always read the data. POSH records filed before migration 006 may already have been seen by HR, and their earlier audit entries still contain names. Do not treat this as proof of a legally compliant grievance process; the ICC's constitution, notices, and procedure need separate legal review.

Qualified Indian privacy/employment counsel should assess Aadhaar handling, workforce/candidate processing, grievance confidentiality, and document/offer wording. "Reviewed by HR" describes a human review only; it does not assert government identity verification. No legal-compliance certification is made.
