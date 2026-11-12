-- Migration 018: Custom probation duration (days or months) per employee.
ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS probation_duration INT NOT NULL DEFAULT 90 CHECK (probation_duration BETWEEN 1 AND 3650),
  ADD COLUMN IF NOT EXISTS probation_unit VARCHAR(10) NOT NULL DEFAULT 'days' CHECK (probation_unit IN ('days', 'months'));

