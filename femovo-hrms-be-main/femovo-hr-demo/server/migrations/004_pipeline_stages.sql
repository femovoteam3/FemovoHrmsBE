-- Migration 004: Pipeline Stages Update
-- Expand stage column to support new descriptive stage names
ALTER TABLE applicants ALTER COLUMN stage TYPE VARCHAR(100);

-- Migrate existing legacy stages to the new Talent and HR Pipeline structure
UPDATE applicants 
SET stage = 'Screening round (Telephonic call)' 
WHERE stage = 'HR Round';

UPDATE applicants 
SET stage = 'HR L1 Round (taken by HR assistance)' 
WHERE stage = 'Department Round';

UPDATE applicants 
SET stage = 'Final decision/result' 
WHERE stage = 'Selected';
