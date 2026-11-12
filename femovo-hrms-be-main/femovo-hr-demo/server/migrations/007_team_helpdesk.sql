-- Migration 007: Team Helpdesk conversations addressed to the CEO, HR, or a team head.

-- Recruitment accounts have no employees row, so filers cannot be restricted to that table.
ALTER TABLE support_tickets DROP CONSTRAINT IF EXISTS support_tickets_employee_id_fkey;
ALTER TABLE support_tickets ALTER COLUMN employee_id TYPE VARCHAR(50);

ALTER TABLE support_tickets
  ADD COLUMN IF NOT EXISTS recipient_type VARCHAR(20) NOT NULL DEFAULT 'HR',
  ADD COLUMN IF NOT EXISTS recipient_id VARCHAR(50),
  ADD COLUMN IF NOT EXISTS recipient_name VARCHAR(100);

UPDATE support_tickets SET recipient_type = 'ICC' WHERE is_confidential = TRUE;

CREATE TABLE IF NOT EXISTS ticket_messages (
  id SERIAL PRIMARY KEY,
  ticket_id INT NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  author_id VARCHAR(50),
  author_name VARCHAR(100) NOT NULL,
  body TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ticket_messages_ticket ON ticket_messages(ticket_id, id);
CREATE INDEX IF NOT EXISTS idx_support_tickets_recipient ON support_tickets(recipient_id);
