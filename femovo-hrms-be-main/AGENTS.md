# Security & Repository Guidelines

## 1. Credentials & Environment Files Protection
- **NEVER COMMIT OR PUSH CREDENTIALS**:
  - Do NOT commit or push `.env`, `.env.*`, `.env.production`, `.env.local`, or any file containing real database connection strings, JWT secrets, passwords, or API credentials.
  - Only safe template files such as `.env.example` containing empty or dummy placeholder values are permitted in Git.
  - All `.gitignore` files (`root`, `client/.gitignore`, `server/.gitignore`) must strictly maintain patterns ignoring `.env` and `.env.*`.
  - Always verify with `git status` or `git diff --cached` before staging or committing to confirm no secrets are included.

## 2. Target Repositories
- **Frontend Code (Client)**:
  - Repository URL: `https://github.com/pawanghodekar/femovo-hrms.git`
  - Scope: React + Vite application under `client/`
  - Build command: `npm run build`
  - Output directory: `dist/` (ignored from Git)
- **Backend Code (Server / API)**:
  - Repository URL: `https://github.com/pawanghodekar/femovo-hrms-be.git`
  - Scope: Express.js REST API, database migrations, authentication, RBAC policies, and test suites
  - Start command: `npm start`
