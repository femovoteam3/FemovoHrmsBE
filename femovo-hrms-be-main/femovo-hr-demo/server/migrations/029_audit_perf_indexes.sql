-- Migration 029: Performance indexes for attendance_records(date) and leaves(status)
-- Supports /api/stats dashboard counts and TODAY_ATTENDANCE employee subqueries.

CREATE INDEX IF NOT EXISTS idx_attendance_records_date
  ON attendance_records(date);

CREATE INDEX IF NOT EXISTS idx_leaves_status
  ON leaves(status);

