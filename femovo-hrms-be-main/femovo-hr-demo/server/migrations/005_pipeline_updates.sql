-- Migration 005: Add monthly salary and remarks to applicants
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS monthly_salary VARCHAR(50);
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS remarks TEXT;
