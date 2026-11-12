-- Sync EMS permissions matrix to remove unused legacy actions and ensure training module permissions exist for every role
DELETE FROM user_specific_permissions
WHERE permission_key IN (
  'dashboard:export_reports',
  'employees:view_password',
  'attendance:manage_shifts',
  'leaves:edit_balances',
  'onboarding:reject_docs',
  'ats:create_job',
  'ats:manage_candidates',
  'ats:schedule_interviews',
  'ats:issue_offers',
  'audit:export_logs'
);

DELETE FROM role_permissions
WHERE (module = 'dashboard' AND action = 'export_reports')
   OR (module = 'employees' AND action = 'view_password')
   OR (module = 'attendance' AND action = 'manage_shifts')
   OR (module = 'leaves' AND action = 'edit_balances')
   OR (module = 'onboarding' AND action = 'reject_docs')
   OR (module = 'ats' AND action IN ('create_job', 'manage_candidates', 'schedule_interviews', 'issue_offers'))
   OR (module = 'audit' AND action = 'export_logs');

-- Guarantee Super Admin always has allowed = true for all remaining role_permissions
UPDATE role_permissions SET allowed = true WHERE role_id = 'super_admin' AND allowed = false;

