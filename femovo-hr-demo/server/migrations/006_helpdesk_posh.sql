-- Migration 006: Separate POSH complaints from support tickets and add named ICC members.
ALTER TABLE user_accounts ADD COLUMN IF NOT EXISTS is_icc_member BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE support_tickets
  ADD COLUMN IF NOT EXISTS respondent_name VARCHAR(200),
  ADD COLUMN IF NOT EXISTS incident_date DATE,
  ADD COLUMN IF NOT EXISTS incident_place VARCHAR(200),
  ADD COLUMN IF NOT EXISTS witnesses TEXT;

-- Ticket numbers no longer depend on a row count, which could collide under concurrent filing.
CREATE SEQUENCE IF NOT EXISTS support_ticket_number_seq;
SELECT setval('support_ticket_number_seq', GREATEST((SELECT COUNT(*) FROM support_tickets), (SELECT COALESCE(MAX(id), 0) FROM support_tickets), 1));

-- Every POSH record becomes confidential, including any filed with the old checkbox cleared.
UPDATE support_tickets SET is_confidential = TRUE WHERE category = 'POSH / Harassment';
UPDATE support_tickets SET is_confidential = FALSE WHERE is_confidential IS NULL;

UPDATE support_tickets
SET assigned_to = 'Internal Complaints Committee (ICC)',
    status = CASE status
      WHEN 'Open' THEN 'Received'
      WHEN 'Under Review' THEN 'Under Inquiry'
      WHEN 'In Investigation' THEN 'Under Inquiry'
      WHEN 'Resolved' THEN 'Closed'
      ELSE status
    END
WHERE is_confidential = TRUE;

UPDATE support_tickets
SET status = CASE status
      WHEN 'Under Review' THEN 'In Progress'
      WHEN 'In Investigation' THEN 'In Progress'
      WHEN 'Closed' THEN 'Resolved'
      ELSE status
    END
WHERE is_confidential = FALSE;
