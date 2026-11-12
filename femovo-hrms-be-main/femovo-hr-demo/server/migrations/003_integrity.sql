ALTER TABLE payroll_runs ALTER COLUMN days_present TYPE NUMERIC(7,2);
ALTER TABLE payroll_runs ALTER COLUMN status SET DEFAULT 'Calculated';
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS promoted_employee_id VARCHAR(20);

CREATE OR REPLACE FUNCTION revoke_changed_account_sessions() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.pin IS DISTINCT FROM OLD.pin OR NEW.role IS DISTINCT FROM OLD.role OR
     NEW.ats_role IS DISTINCT FROM OLD.ats_role OR NEW.status IS DISTINCT FROM OLD.status THEN
    NEW.session_version := OLD.session_version + 1;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS account_session_revocation ON user_accounts;
CREATE TRIGGER account_session_revocation BEFORE UPDATE ON user_accounts
FOR EACH ROW EXECUTE FUNCTION revoke_changed_account_sessions();

CREATE OR REPLACE FUNCTION revoke_changed_resource_sessions() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'employees' THEN
    IF NEW.has_dashboard_access IS DISTINCT FROM OLD.has_dashboard_access OR NEW.status IS DISTINCT FROM OLD.status THEN
      UPDATE user_accounts SET session_version=session_version+1 WHERE employee_id=NEW.id;
    END IF;
  ELSE
    IF NEW.has_ats_access IS DISTINCT FROM OLD.has_ats_access OR NEW.status IS DISTINCT FROM OLD.status THEN
      UPDATE user_accounts SET session_version=session_version+1 WHERE recruiter_id=NEW.id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS employee_session_revocation ON employees;
CREATE TRIGGER employee_session_revocation AFTER UPDATE ON employees
FOR EACH ROW EXECUTE FUNCTION revoke_changed_resource_sessions();
DROP TRIGGER IF EXISTS recruiter_session_revocation ON recruitment_team;
CREATE TRIGGER recruiter_session_revocation AFTER UPDATE ON recruitment_team
FOR EACH ROW EXECUTE FUNCTION revoke_changed_resource_sessions();

-- Reject future plaintext writes while retaining an empty compatibility column.
UPDATE user_accounts SET plain_pin=NULL;
ALTER TABLE user_accounts ADD CONSTRAINT no_plaintext_password_copy CHECK (plain_pin IS NULL);

CREATE OR REPLACE FUNCTION prevent_audit_changes() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Audit entries are append-only';
END;
$$;
DROP TRIGGER IF EXISTS protect_audit_history ON audit_logs;
CREATE TRIGGER protect_audit_history BEFORE UPDATE OR DELETE ON audit_logs
FOR EACH ROW EXECUTE FUNCTION prevent_audit_changes();
