-- Migration 009: Revoke legacy onboarding approvals that do not meet the
-- current submission and required-document rules.
WITH required_documents(doc_type) AS (
  VALUES ('aadhaar'), ('pan'), ('bank_proof'), ('degree'), ('photo')
)
UPDATE employee_personal_details profile
SET hr_verified = FALSE,
    hr_verified_at = NULL,
    hr_verified_by = NULL
WHERE profile.hr_verified = TRUE
  AND (
    profile.onboarding_submitted IS NOT TRUE
    OR EXISTS (
      SELECT 1
      FROM required_documents required
      WHERE NOT EXISTS (
        SELECT 1
        FROM employee_uploaded_documents document
        WHERE document.employee_id = profile.employee_id
          AND document.doc_type = required.doc_type
      )
    )
  );
