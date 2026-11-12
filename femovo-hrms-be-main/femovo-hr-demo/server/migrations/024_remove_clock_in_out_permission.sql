-- Retire obsolete clock_in_out permission after removing Live Punch & Shift Timer
DELETE FROM user_specific_permissions WHERE permission_key = 'attendance:clock_in_out';
DELETE FROM role_permissions WHERE module = 'attendance' AND action = 'clock_in_out';

