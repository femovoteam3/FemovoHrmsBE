-- Ensure built-in roles are marked is_system = true so they cannot be deleted
UPDATE roles
SET is_system = true
WHERE id IN ('super_admin', 'admin', 'employee', 'manager', 'recruiter', 'trainers', 'head', 'hr', 'hr_assistant', 'interviewer');

-- Ensure every role has rows for all active EMS modules (including training)
WITH active_actions(module, action) AS (
  VALUES
    ('dashboard', 'view'),
    ('dashboard', 'view_analytics'),
    ('employees', 'view'),
    ('employees', 'add'),
    ('employees', 'edit'),
    ('employees', 'delete'),
    ('employees', 'view_sensitive'),
    ('attendance', 'view'),
    ('attendance', 'regularize'),
    ('leaves', 'view'),
    ('leaves', 'apply'),
    ('leaves', 'approve_reject'),
    ('onboarding', 'view'),
    ('onboarding', 'upload_docs'),
    ('onboarding', 'verify_kyc'),
    ('ats', 'view'),
    ('exits', 'view'),
    ('exits', 'submit_resignation'),
    ('exits', 'clearance_settlement'),
    ('training', 'view'),
    ('training', 'edit'),
    ('notices', 'view'),
    ('notices', 'post_notice'),
    ('notices', 'send_kudos'),
    ('helpdesk', 'view'),
    ('helpdesk', 'submit_ticket'),
    ('helpdesk', 'resolve_ticket'),
    ('audit', 'view'),
    ('permissions', 'view'),
    ('permissions', 'create_role'),
    ('permissions', 'edit_permissions'),
    ('permissions', 'delete_role')
)
INSERT INTO role_permissions (role_id, module, action, allowed)
SELECT r.id, a.module, a.action, (r.id IN ('super_admin', 'admin'))
FROM roles r
CROSS JOIN active_actions a
ON CONFLICT (role_id, module, action) DO NOTHING;

-- Super Admin always retains allowed = true across all modules & actions
UPDATE role_permissions
SET allowed = true
WHERE role_id = 'super_admin' AND allowed = false;

-- Administrator (admin) retains full system feature permissions
UPDATE role_permissions
SET allowed = true
WHERE role_id = 'admin' AND allowed = false;

-- Staff Employee (employee) essential self-service permissions
UPDATE role_permissions
SET allowed = true
WHERE role_id = 'employee'
  AND (
    (module = 'onboarding' AND action IN ('view', 'upload_docs'))
    OR (module = 'exits' AND action IN ('view', 'submit_resignation'))
    OR (module = 'notices' AND action IN ('view', 'send_kudos'))
    OR (module = 'helpdesk' AND action IN ('view', 'submit_ticket'))
    OR (module = 'training' AND action = 'view')
  );

-- Trainers role baseline permissions
UPDATE role_permissions
SET allowed = true
WHERE role_id = 'trainers'
  AND (
    (module = 'training' AND action = 'view')
    OR (module = 'onboarding' AND action IN ('view', 'upload_docs'))
    OR (module = 'notices' AND action IN ('view', 'send_kudos'))
    OR (module = 'helpdesk' AND action IN ('view', 'submit_ticket'))
    OR (module = 'exits' AND action IN ('view', 'submit_resignation'))
  );

-- Clean up orphaned legacy ATS permission rows not matching current ATS modules
DELETE FROM ats_role_permissions
WHERE module NOT IN ('candidate_lifecycle', 'workflow', 'jobs', 'offers', 'team');

-- Guarantee Super Admin (FEM-001) never loses ATS active flag if present in recruitment_team
UPDATE recruitment_team rt
SET has_ats_access = true,
    status = 'Active'
FROM user_accounts ua
WHERE ua.role = 'super_admin'
  AND (rt.employee_id = ua.employee_id OR rt.id = ua.recruiter_id);

