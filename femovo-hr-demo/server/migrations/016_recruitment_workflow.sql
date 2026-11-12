-- Migration 016: Eight-step recruitment workflow (Head HR round, CEO approval, interviews, offers, assignments).

-- 1. Stages. Renaming is not a real move, so the days a candidate has waited are kept.
ALTER TABLE applicants DISABLE TRIGGER applicant_stage_time;
ALTER TABLE applicants DROP CONSTRAINT IF EXISTS applicants_stage_valid;
UPDATE applicants SET stage = CASE stage WHEN 'HR Round' THEN 'Head HR Round' WHEN 'Selected' THEN 'Approved' ELSE stage END;
ALTER TABLE applicants ENABLE TRIGGER applicant_stage_time;
ALTER TABLE applicants ADD CONSTRAINT applicants_stage_valid
  CHECK (stage IN ('New', 'Screening', 'HR L1', 'Head HR Round', 'CEO Approval', 'Approved', 'Rejected'));

-- 2. Decisions and statuses are kept apart from the pipeline stage.
ALTER TABLE applicants
  ADD COLUMN IF NOT EXISTS backup_recruiter_id VARCHAR(50),
  ADD COLUMN IF NOT EXISTS extra_round_required BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS head_hr_recommendation TEXT,
  ADD COLUMN IF NOT EXISTS head_hr_recommended_by VARCHAR(100),
  ADD COLUMN IF NOT EXISTS head_hr_recommended_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ceo_decision VARCHAR(30) CHECK (ceo_decision IN ('approved', 'rejected', 'sent_back', 'interview_requested')),
  ADD COLUMN IF NOT EXISTS ceo_remarks TEXT,
  ADD COLUMN IF NOT EXISTS ceo_decided_by VARCHAR(100),
  ADD COLUMN IF NOT EXISTS ceo_decided_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS offer_status VARCHAR(20) CHECK (offer_status IN ('Draft', 'Issued', 'Accepted', 'Declined', 'Withdrawn')),
  ADD COLUMN IF NOT EXISTS onboarded_at TIMESTAMPTZ;

-- Candidates selected before the CEO step existed are treated as finally approved.
UPDATE applicants SET ceo_decision = 'approved', ceo_remarks = 'Approved before the CEO approval step existed', ceo_decided_at = stage_changed_at
WHERE stage = 'Approved' AND ceo_decision IS NULL;
UPDATE applicants SET onboarded_at = stage_changed_at, offer_status = 'Accepted'
WHERE promoted_employee_id IS NOT NULL AND onboarded_at IS NULL;

ALTER TABLE job_requisitions
  ADD COLUMN IF NOT EXISTS backup_recruiter_id VARCHAR(50),
  ADD COLUMN IF NOT EXISTS hiring_manager_id VARCHAR(50),
  ADD COLUMN IF NOT EXISTS requirements TEXT;

ALTER TABLE recruitment_team
  ADD COLUMN IF NOT EXISTS employee_id VARCHAR(50),
  ADD COLUMN IF NOT EXISTS reports_to_id VARCHAR(50);

-- 3. Which departments, roles and jobs each HR Assistant handles.
CREATE TABLE IF NOT EXISTS recruiter_assignments (
  id SERIAL PRIMARY KEY,
  recruiter_id VARCHAR(50) NOT NULL REFERENCES recruitment_team(id) ON DELETE CASCADE,
  kind VARCHAR(20) NOT NULL CHECK (kind IN ('job', 'role', 'department')),
  job_id INTEGER REFERENCES job_requisitions(id) ON DELETE CASCADE,
  target VARCHAR(100),
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  created_by VARCHAR(100),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((kind = 'job' AND job_id IS NOT NULL AND target IS NULL)
      OR (kind <> 'job' AND job_id IS NULL AND target IS NOT NULL AND btrim(target) <> ''))
);
CREATE UNIQUE INDEX IF NOT EXISTS recruiter_assignments_job ON recruiter_assignments(recruiter_id, job_id) WHERE kind = 'job';
CREATE UNIQUE INDEX IF NOT EXISTS recruiter_assignments_target ON recruiter_assignments(recruiter_id, kind, LOWER(target)) WHERE kind <> 'job';
CREATE INDEX IF NOT EXISTS recruiter_assignments_lookup ON recruiter_assignments(kind, LOWER(target));

-- Each HR Assistant starts with the department they already work for. No candidate is reassigned.
INSERT INTO recruiter_assignments (recruiter_id, kind, target, created_by)
SELECT id, 'department', btrim(department), 'migration'
FROM recruitment_team
WHERE ats_role = 'rec_associate' AND status = 'Active' AND is_head IS NOT TRUE AND btrim(COALESCE(department, '')) <> ''
ON CONFLICT DO NOTHING;

-- 4. Interviews. A candidate can have many, and rescheduling no longer overwrites history.
CREATE TABLE IF NOT EXISTS interviews (
  id SERIAL PRIMARY KEY,
  applicant_id INTEGER NOT NULL REFERENCES applicants(id) ON DELETE CASCADE,
  type VARCHAR(20) NOT NULL CHECK (type IN ('screening', 'hr_l1', 'additional', 'head_hr', 'ceo')),
  interviewer_id VARCHAR(50),
  interviewer_name VARCHAR(100),
  scheduled_at TIMESTAMPTZ,
  timezone VARCHAR(50) NOT NULL DEFAULT 'Asia/Kolkata',
  platform VARCHAR(30) NOT NULL DEFAULT 'Google Meet',
  meeting_url TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'Scheduled'
    CHECK (status IN ('Scheduled', 'Rescheduled', 'Completed', 'Cancelled', 'No Show', 'Feedback Pending')),
  required BOOLEAN NOT NULL DEFAULT TRUE,
  rating INTEGER CHECK (rating BETWEEN 1 AND 5),
  scorecard JSONB NOT NULL DEFAULT '{}'::jsonb,
  notes TEXT,
  recommendation VARCHAR(20) CHECK (recommendation IN ('Strong Hire', 'Hire', 'Another review', 'Reject')),
  created_by VARCHAR(100),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS interviews_applicant ON interviews(applicant_id);
CREATE INDEX IF NOT EXISTS interviews_interviewer ON interviews(interviewer_id, status);

-- The single interview kept on each candidate becomes their first interview record.
INSERT INTO interviews (applicant_id, type, interviewer_id, interviewer_name, scheduled_at, meeting_url, status, rating, notes, recommendation, created_by, completed_at)
SELECT a.id,
  CASE a.stage WHEN 'New' THEN 'screening' WHEN 'Screening' THEN 'screening' WHEN 'HR L1' THEN 'hr_l1' WHEN 'Rejected' THEN 'hr_l1' ELSE 'head_hr' END,
  a.interviewer_id, a.interviewer, a.interview_date, a.meet_link,
  CASE WHEN COALESCE(a.rating, 0) > 0 OR btrim(COALESCE(a.scorecard_notes, '')) <> '' THEN 'Completed' ELSE 'Scheduled' END,
  CASE WHEN a.rating BETWEEN 1 AND 5 THEN a.rating END,
  NULLIF(btrim(COALESCE(a.scorecard_notes, '')), ''),
  CASE WHEN a.scorecard_notes ILIKE '[STRONG HIRE]%' THEN 'Strong Hire'
       WHEN a.scorecard_notes ILIKE '[HIRE]%' THEN 'Hire'
       WHEN a.scorecard_notes ILIKE '[REJECT]%' THEN 'Reject'
       WHEN a.scorecard_notes ILIKE '[HOLD]%' THEN 'Another review' END,
  'migration',
  CASE WHEN COALESCE(a.rating, 0) > 0 OR btrim(COALESCE(a.scorecard_notes, '')) <> '' THEN COALESCE(a.stage_changed_at, a.created_at, NOW()) END
FROM applicants a
WHERE a.interview_date IS NOT NULL OR COALESCE(a.rating, 0) > 0 OR btrim(COALESCE(a.scorecard_notes, '')) <> '';

-- 5. Who forwarded, assigned, approved or rejected a candidate, and when.
CREATE TABLE IF NOT EXISTS candidate_events (
  id BIGSERIAL PRIMARY KEY,
  applicant_id INTEGER NOT NULL REFERENCES applicants(id) ON DELETE CASCADE,
  kind VARCHAR(20) NOT NULL CHECK (kind IN ('stage', 'assignment', 'interview', 'recommendation', 'ceo_decision', 'offer', 'onboarding', 'note')),
  from_value TEXT,
  to_value TEXT,
  actor_id VARCHAR(50),
  actor_name VARCHAR(100) NOT NULL,
  remarks TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS candidate_events_applicant ON candidate_events(applicant_id, created_at);

INSERT INTO candidate_events (applicant_id, kind, to_value, actor_name, remarks, created_at)
SELECT id, 'stage', stage, 'System', 'Stage when recruitment history started', COALESCE(stage_changed_at, created_at, NOW())
FROM applicants;

-- 6. Offers and their status.
CREATE TABLE IF NOT EXISTS offers (
  id SERIAL PRIMARY KEY,
  applicant_id INTEGER NOT NULL REFERENCES applicants(id) ON DELETE CASCADE,
  designation VARCHAR(100) NOT NULL,
  department VARCHAR(100) NOT NULL,
  annual_ctc NUMERIC(12, 2) NOT NULL CHECK (annual_ctc > 0),
  basic NUMERIC(12, 2) NOT NULL CHECK (basic >= 0),
  hra NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (hra >= 0),
  allowances NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (allowances >= 0),
  deductions NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (deductions >= 0),
  joining_date DATE NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'Issued' CHECK (status IN ('Draft', 'Issued', 'Accepted', 'Declined', 'Withdrawn')),
  notes TEXT,
  created_by VARCHAR(100),
  issued_by VARCHAR(100),
  issued_at TIMESTAMPTZ,
  decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- A candidate has at most one offer that is still alive.
CREATE UNIQUE INDEX IF NOT EXISTS offers_one_open ON offers(applicant_id) WHERE status IN ('Draft', 'Issued', 'Accepted');

-- 7. In-app notifications.
CREATE TABLE IF NOT EXISTS notifications (
  id BIGSERIAL PRIMARY KEY,
  employee_id VARCHAR(50) NOT NULL,
  type VARCHAR(40) NOT NULL,
  title VARCHAR(200) NOT NULL,
  body TEXT,
  route VARCHAR(50),
  applicant_id INTEGER REFERENCES applicants(id) ON DELETE CASCADE,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS notifications_inbox ON notifications(employee_id, read_at, created_at DESC);

-- 8. Roles and permissions. Only switches the server enforces are kept.
INSERT INTO ats_roles (id, name, description, badge_color, is_system) VALUES
  ('ceo', 'CEO', 'Sees all recruitment and gives the final approval.', '#7c3aed', TRUE),
  ('rec_lead', 'Head HR', 'Runs recruitment, takes the Head HR round and issues offers.', '#059669', TRUE),
  ('rec_associate', 'HR Assistant', 'Screens and interviews the candidates assigned to them.', '#2563eb', TRUE),
  ('hiring_manager', 'Interviewer', 'Takes interviews assigned to them and gives feedback.', '#d97706', TRUE)
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description;
UPDATE ats_roles SET name = 'Admin (older role)', description = 'Older full-access recruitment role. New people get CEO or Head HR instead.' WHERE id = 'exec_sponsor';

DELETE FROM ats_role_permissions WHERE action NOT IN (
  'view_candidates', 'create_candidates', 'edit_candidates', 'delete_candidates', 'assign_candidates', 'submit_feedback', 'view_all_candidates', 'export_candidates',
  'screen_candidates', 'run_hr_l1', 'run_additional_interview', 'run_head_hr_round', 'request_additional_interview', 'recommend_to_ceo', 'final_approval',
  'create_jobs', 'edit_jobs', 'publish_jobs', 'view_salary', 'issue_offers', 'onboard_to_ems', 'manage_ats_users', 'assign_recruiters', 'configure_permissions'
);
