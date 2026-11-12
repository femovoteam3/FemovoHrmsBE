-- Migration 014: Some records stored a job title in the recruiter name field.
-- Replace it with the person's real name wherever the recruiter is known.
UPDATE applicants a
SET assigned_recruiter_name = r.name
FROM recruitment_team r
WHERE a.assigned_recruiter_id = r.id
  AND a.assigned_recruiter_name IS DISTINCT FROM r.name;

UPDATE job_requisitions j
SET assigned_recruiter_name = r.name,
    assigned_recruiter_role = r.role_title
FROM recruitment_team r
WHERE j.assigned_recruiter_id = r.id
  AND (j.assigned_recruiter_name IS DISTINCT FROM r.name
    OR j.assigned_recruiter_role IS DISTINCT FROM r.role_title);
