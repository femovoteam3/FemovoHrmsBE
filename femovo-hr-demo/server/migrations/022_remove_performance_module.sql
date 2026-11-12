-- Migration 022: Retire Goals & Performance module FE & BE while preserving historical rows.
DELETE FROM user_specific_permissions
WHERE permission_key LIKE 'performance:%';

DELETE FROM role_permissions
WHERE module = 'performance';

