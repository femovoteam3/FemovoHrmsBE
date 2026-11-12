-- Migration 015: One five-stage pipeline, and candidates linked to the real job record.

-- Renaming a stage is not a real move, so the days a candidate has waited must be kept.
ALTER TABLE applicants DISABLE TRIGGER applicant_stage_time;

-- One statement, so the old 'HR Round' (which meant screening) cannot be confused with the new one.
UPDATE applicants SET stage = CASE stage
  WHEN 'Application' THEN 'New'
  WHEN 'Screening round (Telephonic call)' THEN 'Screening'
  WHEN 'HR Round' THEN 'Screening'
  WHEN 'HR L1 Round (taken by HR assistance)' THEN 'HR L1'
  WHEN 'Department Round' THEN 'HR L1'
  WHEN 'Selected to HR Round' THEN 'HR Round'
  WHEN 'Selected from HR L1' THEN 'HR Round'
  WHEN 'Confirm to Select but Final status pending' THEN 'HR Round'
  WHEN 'Final decision/result' THEN 'Selected'
  ELSE stage
END;

ALTER TABLE applicants ENABLE TRIGGER applicant_stage_time;

ALTER TABLE applicants ALTER COLUMN stage SET DEFAULT 'New';
ALTER TABLE applicants ADD CONSTRAINT applicants_stage_valid
  CHECK (stage IN ('New', 'Screening', 'HR L1', 'HR Round', 'Selected', 'Rejected'));

-- A candidate belongs to a job by id, not by matching its title text.
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS job_id INTEGER REFERENCES job_requisitions(id) ON DELETE SET NULL;
UPDATE applicants a SET job_id = (
  SELECT j.id FROM job_requisitions j
  WHERE LOWER(j.role) = LOWER(a.job)
  ORDER BY (j.status = 'Active') DESC, j.id
  LIMIT 1
)
WHERE a.job_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_applicants_job_id ON applicants(job_id);
