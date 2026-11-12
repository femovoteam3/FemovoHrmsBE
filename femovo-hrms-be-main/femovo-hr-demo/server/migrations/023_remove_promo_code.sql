-- Remove obsolete promo_code column from employees table (Resource Management)
ALTER TABLE employees DROP COLUMN IF EXISTS promo_code;

