-- Migration 030: Enforce uniqueness of active (non-Rejected, non-promoted) applications per email and job_id.

CREATE UNIQUE INDEX IF NOT EXISTS idx_applicants_unique_active_email_job
  ON applicants (LOWER(email), job_id)
  WHERE stage <> 'Rejected' AND promoted_employee_id IS NULL;

