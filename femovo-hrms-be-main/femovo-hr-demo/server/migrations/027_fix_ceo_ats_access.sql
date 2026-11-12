-- Ensure CEO FEM-002 retains active Recruitment ATS access after duplicate REC-001 merge
UPDATE recruitment_team
SET has_ats_access = TRUE,
    status = 'Active'
WHERE id = 'FEM-002'
  AND ats_role = 'ceo';

