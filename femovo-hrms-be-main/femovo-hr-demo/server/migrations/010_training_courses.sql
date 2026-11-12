-- Migration 010: HR-managed courses, assignments, and a training record for each person.
-- The old shared "complete" flag cannot be attributed to anyone, so it is left unused.
ALTER TABLE training
  ADD COLUMN IF NOT EXISTS duration VARCHAR(30),
  ADD COLUMN IF NOT EXISTS pass_percent INT NOT NULL DEFAULT 60 CHECK (pass_percent BETWEEN 1 AND 100),
  ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'Draft' CHECK (status IN ('Draft', 'Published', 'Archived')),
  ADD COLUMN IF NOT EXISTS lesson_items JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS quiz_items JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE TABLE IF NOT EXISTS training_assignments (
  id SERIAL PRIMARY KEY,
  training_id INT NOT NULL REFERENCES training(id) ON DELETE CASCADE,
  scope VARCHAR(20) NOT NULL CHECK (scope IN ('all', 'department', 'employee')),
  target VARCHAR(100),
  due_date DATE,
  assigned_by_name VARCHAR(100) NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS training_progress (
  employee_id VARCHAR(50) NOT NULL,
  training_id INT NOT NULL REFERENCES training(id) ON DELETE CASCADE,
  opened_at TIMESTAMP WITH TIME ZONE,
  attempts INT NOT NULL DEFAULT 0,
  best_percent INT NOT NULL DEFAULT 0,
  last_attempt_at TIMESTAMP WITH TIME ZONE,
  passed_at TIMESTAMP WITH TIME ZONE,
  certificate_no VARCHAR(40) UNIQUE,
  PRIMARY KEY (employee_id, training_id)
);

CREATE INDEX IF NOT EXISTS idx_training_assignments_course ON training_assignments(training_id);

-- The four standard courses, kept under their existing IDs and titles where they already exist.
INSERT INTO training (id, title, department, description) VALUES
  (1, 'Sales & Patient Admissions SOP', 'Sales & Support', 'How to handle inquiries, explain programs and complete admissions.'),
  (2, 'Wellness Session Delivery SOP', 'Class Operations', 'The standard structure and safety steps for every wellness session.'),
  (3, 'Workplace Ethics & Conduct', 'Ethics & Compliance', 'Conduct, leave, timesheet and reporting expectations for all staff.'),
  (4, 'Data Security & Privacy', 'Security & Privacy', 'How to protect patient data, credentials and company systems.')
ON CONFLICT (id) DO NOTHING;

SELECT setval(pg_get_serial_sequence('training', 'id'), GREATEST((SELECT MAX(id) FROM training), 1));

UPDATE training SET
  duration = '45 mins',
  status = 'Published',
  lesson_items = $json$[{"title":"Empathetic Health Need Discovery","body":"Listen actively without interrupting. Identify the root cause of the patient inquiry before recommending therapy."},{"title":"Explaining Care Plans & Program Timings","body":"Break down daily session cadence, trainer assignments, and milestones clearly."},{"title":"Handling Objections & Fee Transparency","body":"Provide reassurance on quality, qualified medical guidance, and clear refund policies."},{"title":"Admission Verification & NEFT Reconciliations","body":"Cross-check bank reference numbers with the Finance team prior to enrolling."},{"title":"Member App Access & Welcome Kit Delivery","body":"Issue credentials and welcome orientation materials within 2 hours of enrollment."}]$json$::jsonb,
  quiz_items = $json$[{"question":"What is the mandatory first step when an inquiry contacts FEMOVO?","options":["Immediately quote high-ticket corporate packages","Conduct an empathetic health need discovery & understand patient goals","Forward the caller to the finance accountant","Ask them to visit the clinic tomorrow without asking questions"],"answer":1},{"question":"When can client portal & app access credentials be officially released?","options":["Before receiving any payment","Only after verifying payment reference with finance and logging admission details","After 30 days of trial period","Whenever the client insists verbally"],"answer":1},{"question":"How should fees or scheduling hesitation be resolved with a prospective patient?","options":["Argue with the patient about market prices","Reassure medical quality, holistic care plans, and offer flexible timing slots","Disconnect the support phone call","Tell them to seek care elsewhere"],"answer":1}]$json$::jsonb
WHERE id = 1;

UPDATE training SET
  duration = '55 mins',
  status = 'Published',
  lesson_items = $json$[{"title":"00–05m: Arrival, Welcoming & Injury Pre-Screening","body":"Greet each participant by name and ask if anyone has new spinal/joint pain or fatigue."},{"title":"05–12m: Dynamic Warm-Up & Joint Mobility Activation","body":"Gentle rotational movements to prepare synovial fluid and elevate heart rate safely."},{"title":"12–40m: Main Structured Practice with Tiered Options","body":"Provide beginner, intermediate, and gentle wall-supported alternatives for every posture."},{"title":"40–48m: Cool Down & Gentle Postural Realignment","body":"Gradually lower core temperature and transition towards parasympathetic state."},{"title":"48–53m: Breathwork, Pranayama & Savasana Rest","body":"Guide diaphragmatic breathing for stress reduction and nervous system regulation."},{"title":"53–55m: Closing & Personal Feedback Q&A","body":"Acknowledge participant effort and answer individual questions before class dismissal."}]$json$::jsonb,
  quiz_items = $json$[{"question":"What must every trainer verify during the first 5 minutes of a wellness session?","options":["Check their smartphone social media","Screen participants for injuries, energy levels, and welcome everyone warmly","Immediately start intense physical drills","Distribute feedback surveys"],"answer":1},{"question":"If a member experiences sharp joint discomfort during practice, what is required?","options":["Instruct them to push through the pain","Immediately provide a gentle tiered modification or resting posture","Ask them to leave the class premises","Ignore the issue"],"answer":1},{"question":"What is the required duration for cool-down, breathwork, and final relaxation?","options":["0 minutes (dismiss immediately)","Approximately 15 minutes (from minute 40 to 55)","45 minutes","1 minute"],"answer":1}]$json$::jsonb
WHERE id = 2;

UPDATE training SET
  duration = '30 mins',
  status = 'Published',
  lesson_items = $json$[{"title":"Professional Conduct & Respectful Workplace Communication","body":"Uphold courtesy, constructive teamwork, and non-discriminatory collaboration."},{"title":"POSH Committee & 100% Confidential Grievance Mechanism","body":"Zero tolerance for any form of workplace harassment. Complaints are reviewed strictly confidentially by ICC."},{"title":"Confidential Menstrual & Mental Wellness Leave (1 Day/Month)","body":"Female and wellness-seeking staff can take 1 day per month via the self-service portal with zero medical certificate."},{"title":"Timesheet Accountability & Punch-In Regularization Rules","body":"All punches must be regularized within 24 hours of shift completion for accurate salary payouts."},{"title":"Whistleblower Protection & Non-Retaliation Commitment","body":"FEMOVO guarantees protection against retaliation for any good-faith reporting of ethical non-compliance."}]$json$::jsonb,
  quiz_items = $json$[{"question":"How are POSH complaints handled under FEMOVO internal policies?","options":["Announced in the general company chat","100% confidential investigation conducted by the Internal Complaints Committee (ICC)","Ignored by department heads","Subject to mandatory public debate"],"answer":1},{"question":"What is the entitlement for confidential monthly wellness / menstrual leave?","options":["Requires 3 signed doctor prescriptions","1 day per month available directly through self-service without requiring a doctor certificate","Deducted at double salary penalties","Only permitted once every 2 years"],"answer":1},{"question":"When should timesheet regularizations or missed punch-ins be submitted?","options":["At the end of the year","Within 24 hours of occurrence for HR review and accurate payroll processing","Never","After 6 months"],"answer":1}]$json$::jsonb
WHERE id = 3;

UPDATE training SET
  duration = '35 mins',
  status = 'Published',
  lesson_items = $json$[{"title":"Safeguarding Sensitive Patient Medical Data & Diagnostic Records","body":"All health histories, blood reports, and therapy notes must be stored securely inside encrypted vaults."},{"title":"Credentials Security & Strict PIN / Password Secrecy","body":"Never share login PINs, database credentials, or API keys with colleagues or outside contractors."},{"title":"Workstation Lock Policy (Win + L)","body":"Always lock screens when stepping away from desks to prevent unauthorized access in open offices."},{"title":"Identifying & Defending Phishing Attempts","body":"Never open unsolicited attachments or share passwords with callers claiming to be IT support without verification."},{"title":"Immediate Incident Reporting Protocols","body":"Report any suspected data leak or unauthorized device connection to HR Operations & Technology Head immediately."}]$json$::jsonb,
  quiz_items = $json$[{"question":"Are staff permitted to share patient lab reports over unsecured personal social media?","options":["Yes, if the patient is a friend","Strictly prohibited; patient health data must remain strictly encrypted within authorized portals","Yes, on weekends","Only with marketing team"],"answer":1},{"question":"What is the standard protocol whenever you step away from your computer workstation?","options":["Leave everything open for others","Lock the screen immediately (Win + L) and ensure no sensitive documents are visible","Turn off the building lights","Share your PIN with a coworker"],"answer":1},{"question":"What should you do if an unknown entity asks for internal employee personal phone numbers?","options":["Hand them over immediately","Refuse the disclosure and report the security inquiry to HR / Compliance officers","Post them on a public forum","Ask for payment first"],"answer":1}]$json$::jsonb
WHERE id = 4;

-- Other courses only ever had lesson names, so they stay as drafts for HR to complete.
UPDATE training
SET lesson_items = (SELECT COALESCE(jsonb_agg(jsonb_build_object('title', lesson, 'body', '')), '[]'::jsonb) FROM unnest(lessons) AS lesson)
WHERE id NOT IN (1, 2, 3, 4) AND lessons IS NOT NULL;
