-- Migration 013: Strengthen training data integrity while preserving JSON-based
-- lesson/video and question/answer content.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'training_progress_employee_fk') THEN
    ALTER TABLE training_progress
      ADD CONSTRAINT training_progress_employee_fk
      FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE NOT VALID;
  END IF;
END $$;

ALTER TABLE training_progress VALIDATE CONSTRAINT training_progress_employee_fk;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'training_lesson_items_array') THEN
    ALTER TABLE training
      ADD CONSTRAINT training_lesson_items_array
      CHECK (jsonb_typeof(lesson_items) = 'array') NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'training_quiz_items_array') THEN
    ALTER TABLE training
      ADD CONSTRAINT training_quiz_items_array
      CHECK (jsonb_typeof(quiz_items) = 'array') NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'training_assignment_target_required') THEN
    ALTER TABLE training_assignments
      ADD CONSTRAINT training_assignment_target_required
      CHECK (
        (scope = 'all' AND target IS NULL)
        OR (scope IN ('department', 'employee') AND NULLIF(BTRIM(target), '') IS NOT NULL)
      ) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'training_progress_values_valid') THEN
    ALTER TABLE training_progress
      ADD CONSTRAINT training_progress_values_valid
      CHECK (attempts >= 0 AND best_percent BETWEEN 0 AND 100) NOT VALID;
  END IF;
END $$;

ALTER TABLE training VALIDATE CONSTRAINT training_lesson_items_array;
ALTER TABLE training VALIDATE CONSTRAINT training_quiz_items_array;
ALTER TABLE training_assignments VALIDATE CONSTRAINT training_assignment_target_required;
ALTER TABLE training_progress VALIDATE CONSTRAINT training_progress_values_valid;
