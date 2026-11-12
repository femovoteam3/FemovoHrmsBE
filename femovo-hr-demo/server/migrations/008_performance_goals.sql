-- Migration 008: Quarterly goals with weekly check-ins and manager comments.
CREATE TABLE IF NOT EXISTS performance_goals (
  id SERIAL PRIMARY KEY,
  employee_id VARCHAR(50) NOT NULL,
  quarter VARCHAR(7) NOT NULL,
  title VARCHAR(200) NOT NULL,
  unit VARCHAR(30),
  target_value NUMERIC(14, 2) NOT NULL CHECK (target_value > 0),
  current_value NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (current_value >= 0),
  status VARCHAR(20) NOT NULL DEFAULT 'Active' CHECK (status IN ('Active', 'Completed', 'Cancelled')),
  created_by_id VARCHAR(50),
  created_by_name VARCHAR(100) NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS goal_checkins (
  id SERIAL PRIMARY KEY,
  goal_id INT NOT NULL REFERENCES performance_goals(id) ON DELETE CASCADE,
  kind VARCHAR(10) NOT NULL CHECK (kind IN ('update', 'comment')),
  author_id VARCHAR(50),
  author_name VARCHAR(100) NOT NULL,
  value NUMERIC(14, 2),
  note TEXT,
  blocker TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_performance_goals_owner ON performance_goals(employee_id, quarter);
CREATE INDEX IF NOT EXISTS idx_goal_checkins_goal ON goal_checkins(goal_id, id);

ALTER TABLE performance_reviews ADD COLUMN IF NOT EXISTS quarter VARCHAR(7);
