ALTER TABLE user_accounts ADD COLUMN IF NOT EXISTS session_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS actor_id INTEGER;
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS resume_upload_token_hash TEXT;
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS resume_upload_expires_at TIMESTAMPTZ;
ALTER TABLE leave_balances ALTER COLUMN cl_balance TYPE NUMERIC(7,2);
ALTER TABLE leave_balances ALTER COLUMN sl_balance TYPE NUMERIC(7,2);
ALTER TABLE leave_balances ALTER COLUMN pl_balance TYPE NUMERIC(7,2);
ALTER TABLE leave_balances ALTER COLUMN wellness_balance TYPE NUMERIC(7,2);
ALTER TABLE leaves ADD COLUMN IF NOT EXISTS deducted_days NUMERIC(7,2) NOT NULL DEFAULT 0;
ALTER TABLE leaves ADD COLUMN IF NOT EXISTS balance_column TEXT;
ALTER TABLE leaves ADD COLUMN IF NOT EXISTS balance_reconciled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE payroll_runs ADD COLUMN IF NOT EXISTS batch_id UUID;
CREATE TABLE IF NOT EXISTS payroll_batches (
  id UUID PRIMARY KEY, month INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
  year INTEGER NOT NULL CHECK (year BETWEEN 2000 AND 2200),
  status TEXT NOT NULL DEFAULT 'Calculated' CHECK(status IN ('Calculated','Approved','Paid')),
  payment_reference TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(month, year)
);
CREATE UNIQUE INDEX IF NOT EXISTS payroll_employee_batch_unique ON payroll_runs(employee_id,batch_id) WHERE batch_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS leaves_employee_period ON leaves(employee_id,from_date,to_date);
CREATE INDEX IF NOT EXISTS personal_document_owner ON employee_uploaded_documents(employee_id);
CREATE INDEX IF NOT EXISTS employees_manager ON employees(manager_id);
CREATE INDEX IF NOT EXISTS payroll_employee_period ON payroll_runs(employee_id,year,month);
