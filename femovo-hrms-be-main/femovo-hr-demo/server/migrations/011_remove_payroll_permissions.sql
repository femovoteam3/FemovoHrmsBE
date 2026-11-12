-- Migration 011: The payroll API and screen are retired. Preserve historical
-- salary/payroll records, but remove obsolete RBAC entries that advertise it.
DELETE FROM user_specific_permissions
WHERE permission_key LIKE 'payroll:%';

DELETE FROM role_permissions
WHERE module = 'payroll';

-- Remove the legacy system role only when no account still depends on it.
DELETE FROM roles
WHERE id = 'payroll_specialist'
  AND NOT EXISTS (
    SELECT 1 FROM user_accounts WHERE role = 'payroll_specialist'
  );
