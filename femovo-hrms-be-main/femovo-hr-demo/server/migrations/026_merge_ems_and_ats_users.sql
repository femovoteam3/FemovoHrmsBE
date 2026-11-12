-- Merge EMS Core (employees) and Recruitment ATS (recruitment_team) users into one shared person pool.

-- 1. Merge duplicate REC-001 (Vaishnavi Lokhande) into FEM-002 (Vaishnavi Lokhande) when both exist.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM employees WHERE id = 'FEM-002')
     AND EXISTS (SELECT 1 FROM recruitment_team WHERE id = 'REC-001') THEN

    INSERT INTO recruitment_team (
      id, name, role_title, department, reports_to, is_head, email, phone,
      avatar_initials, specialization, active_vacancies, has_ats_access,
      ats_role, sourcing_tag, max_candidate_capacity, status, employee_id, reports_to_id
    )
    SELECT
      e.id,
      e.name,
      COALESCE(NULLIF(btrim(e.designation), ''), NULLIF(btrim(e.role), ''), 'CEO'),
      e.department,
      COALESCE(e.manager, ''),
      FALSE,
      COALESCE(NULLIF(btrim(e.email), ''), rt.email),
      COALESCE(e.phone, rt.phone, ''),
      'VL',
      COALESCE(rt.specialization, 'Executive Leadership & Final Approvals'),
      COALESCE(rt.active_vacancies, 0),
      COALESCE(rt.has_ats_access, TRUE),
      COALESCE(NULLIF(btrim(u.ats_role), ''), rt.ats_role, 'ceo'),
      COALESCE(rt.sourcing_tag, 'VAISHNAVI-TAG'),
      COALESCE(rt.max_candidate_capacity, 20),
      CASE WHEN e.status = 'Inactive' THEN 'Inactive' ELSE 'Active' END,
      e.id,
      e.manager_id
    FROM employees e
    JOIN recruitment_team rt ON rt.id = 'REC-001'
    LEFT JOIN user_accounts u ON u.employee_id = e.id
    WHERE e.id = 'FEM-002'
    ON CONFLICT (id) DO UPDATE SET
      employee_id = 'FEM-002',
      ats_role = COALESCE(EXCLUDED.ats_role, recruitment_team.ats_role),
      has_ats_access = TRUE;

    UPDATE applicants
    SET assigned_recruiter_id = 'FEM-002',
        assigned_recruiter_name = (SELECT name FROM employees WHERE id = 'FEM-002')
    WHERE assigned_recruiter_id = 'REC-001';
    UPDATE applicants SET backup_recruiter_id = 'FEM-002' WHERE backup_recruiter_id = 'REC-001';
    UPDATE applicants SET interviewer_id = 'FEM-002' WHERE interviewer_id = 'REC-001';
    UPDATE job_requisitions SET assigned_recruiter_id = 'FEM-002' WHERE assigned_recruiter_id = 'REC-001';
    UPDATE job_requisitions SET backup_recruiter_id = 'FEM-002' WHERE backup_recruiter_id = 'REC-001';
    UPDATE job_requisitions SET hiring_manager_id = 'FEM-002' WHERE hiring_manager_id = 'REC-001';
    UPDATE interviews SET interviewer_id = 'FEM-002' WHERE interviewer_id = 'REC-001';

    DELETE FROM recruiter_assignments ra
    WHERE ra.recruiter_id = 'REC-001'
      AND EXISTS (
        SELECT 1 FROM recruiter_assignments existing
        WHERE existing.recruiter_id = 'FEM-002'
          AND existing.kind = ra.kind
          AND (
            (ra.kind = 'job' AND existing.job_id = ra.job_id)
            OR (ra.kind <> 'job' AND LOWER(existing.target) = LOWER(ra.target))
          )
      );
    UPDATE recruiter_assignments SET recruiter_id = 'FEM-002' WHERE recruiter_id = 'REC-001';

    UPDATE user_accounts
    SET recruiter_id = 'FEM-002',
        ats_role = COALESCE(NULLIF(btrim(ats_role), ''), 'ceo')
    WHERE employee_id = 'FEM-002';

    DELETE FROM user_accounts WHERE employee_id = 'REC-001' OR recruiter_id = 'REC-001';
    DELETE FROM recruitment_team WHERE id = 'REC-001';
  END IF;
END $$;

-- 2. Backfill employees records for any recruitment_team members who only existed in ATS.
INSERT INTO employees (
  id, name, department, role, designation, manager, manager_id, status, attendance,
  email, phone, access_role, has_dashboard_access, user_type
)
SELECT
  rt.id,
  rt.name,
  COALESCE(NULLIF(btrim(rt.department), ''), 'Human Resources & People Operations'),
  COALESCE(NULLIF(btrim(rt.role_title), ''), 'HR Assistant'),
  COALESCE(NULLIF(btrim(rt.role_title), ''), 'HR Assistant'),
  COALESCE(m.name, NULLIF(btrim(rt.reports_to), '')),
  rt.reports_to_id,
  CASE WHEN rt.status = 'Inactive' THEN 'Inactive' ELSE 'Active' END,
  'Present',
  rt.email,
  rt.phone,
  COALESCE(
    NULLIF(btrim(u.role), ''),
    CASE
      WHEN rt.ats_role = 'hiring_manager' THEN 'interviewer'
      WHEN rt.ats_role = 'rec_lead' THEN 'hr'
      ELSE 'recruiter'
    END
  ),
  COALESCE(rt.has_ats_access, TRUE),
  'Staff'
FROM recruitment_team rt
LEFT JOIN employees e ON e.id = rt.id
LEFT JOIN employees m ON m.id = rt.reports_to_id
LEFT JOIN user_accounts u ON u.recruiter_id = rt.id OR u.employee_id = rt.id
WHERE e.id IS NULL
ON CONFLICT (id) DO NOTHING;

UPDATE recruitment_team
SET employee_id = id
WHERE employee_id IS NULL
  AND EXISTS (SELECT 1 FROM employees e WHERE e.id = recruitment_team.id);

-- 3. Ensure every employee who has an ats_role on user_accounts has a linked recruitment_team profile.
INSERT INTO recruitment_team (
  id, name, role_title, department, reports_to, is_head, email, phone,
  avatar_initials, specialization, active_vacancies, has_ats_access,
  ats_role, sourcing_tag, max_candidate_capacity, status, employee_id, reports_to_id
)
SELECT
  e.id,
  e.name,
  COALESCE(NULLIF(btrim(e.designation), ''), NULLIF(btrim(e.role), ''), 'Recruitment Member'),
  COALESCE(NULLIF(btrim(e.department), ''), 'General Operations & Administration'),
  COALESCE(e.manager, ''),
  u.ats_role = 'rec_lead',
  COALESCE(NULLIF(btrim(e.email), ''), u.email),
  COALESCE(e.phone, ''),
  UPPER(LEFT(e.name, 2)),
  COALESCE(NULLIF(btrim(e.department), ''), 'General Hiring'),
  0,
  e.status <> 'Inactive',
  u.ats_role,
  UPPER(COALESCE(NULLIF(REGEXP_REPLACE(SPLIT_PART(e.name, ' ', 1), '[^A-Za-z0-9]+', '', 'g'), ''), 'REC')) || '-TAG',
  20,
  CASE WHEN e.status = 'Inactive' THEN 'Inactive' ELSE 'Active' END,
  e.id,
  e.manager_id
FROM employees e
JOIN user_accounts u ON u.employee_id = e.id
WHERE NULLIF(btrim(COALESCE(u.ats_role, '')), '') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM recruitment_team rt WHERE rt.id = e.id OR rt.employee_id = e.id)
ON CONFLICT (id) DO NOTHING;

UPDATE user_accounts u
SET recruiter_id = rt.id
FROM recruitment_team rt
WHERE u.recruiter_id IS NULL
  AND (rt.employee_id = u.employee_id OR rt.id = u.employee_id);

