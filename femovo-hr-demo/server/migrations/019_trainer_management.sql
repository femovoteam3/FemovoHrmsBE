-- Migration 019: Session-based trainer weekly schedules, session tracking, leave replacements & monthly payout approvals.

CREATE TABLE IF NOT EXISTS trainer_schedules (
  id SERIAL PRIMARY KEY,
  trainer_id VARCHAR(50) NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  batch_name VARCHAR(150) NOT NULL,
  session_type VARCHAR(60) NOT NULL,
  days_of_week JSONB NOT NULL DEFAULT '[]'::jsonb,
  start_time VARCHAR(10) NOT NULL,
  duration_minutes INT NOT NULL DEFAULT 60 CHECK (duration_minutes BETWEEN 15 AND 480),
  payment_model VARCHAR(20) NOT NULL CHECK (payment_model IN ('fixed_monthly', 'per_session')),
  rate_amount NUMERIC(10, 2) NOT NULL DEFAULT 0 CHECK (rate_amount >= 0),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  notes TEXT,
  created_by VARCHAR(100),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS trainer_sessions (
  id SERIAL PRIMARY KEY,
  schedule_id INT REFERENCES trainer_schedules(id) ON DELETE SET NULL,
  session_date DATE NOT NULL,
  start_time VARCHAR(10) NOT NULL,
  batch_name VARCHAR(150) NOT NULL,
  session_type VARCHAR(60) NOT NULL,
  assigned_trainer_id VARCHAR(50) NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  conducted_by_trainer_id VARCHAR(50) REFERENCES employees(id) ON DELETE SET NULL,
  replacement_trainer_id VARCHAR(50) REFERENCES employees(id) ON DELETE SET NULL,
  session_kind VARCHAR(20) NOT NULL DEFAULT 'scheduled' CHECK (session_kind IN ('scheduled', 'extra', 'replacement')),
  status VARCHAR(20) NOT NULL DEFAULT 'Scheduled' CHECK (status IN ('Scheduled', 'Completed', 'Cancelled', 'Missed', 'Leave')),
  payment_amount NUMERIC(10, 2) NOT NULL DEFAULT 0 CHECK (payment_amount >= 0),
  replacement_pay NUMERIC(10, 2) NOT NULL DEFAULT 0 CHECK (replacement_pay >= 0),
  deduction_amount NUMERIC(10, 2) NOT NULL DEFAULT 0 CHECK (deduction_amount >= 0),
  notes TEXT,
  approved BOOLEAN NOT NULL DEFAULT FALSE,
  approved_by VARCHAR(100),
  approved_at TIMESTAMPTZ,
  created_by VARCHAR(100),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_trainer_sessions_unique_scheduled
  ON trainer_sessions(schedule_id, session_date, start_time)
  WHERE schedule_id IS NOT NULL AND session_kind = 'scheduled';

CREATE INDEX IF NOT EXISTS idx_trainer_sessions_month_trainer
  ON trainer_sessions(session_date, assigned_trainer_id);

CREATE TABLE IF NOT EXISTS trainer_monthly_approvals (
  month VARCHAR(7) NOT NULL,
  trainer_id VARCHAR(50) NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  total_payable NUMERIC(10, 2) NOT NULL DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'Approved' CHECK (status IN ('Pending', 'Approved', 'Paid')),
  notes TEXT,
  approved_by VARCHAR(100),
  approved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (month, trainer_id)
);

