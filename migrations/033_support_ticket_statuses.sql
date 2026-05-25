UPDATE support_tickets
SET status = CASE
  WHEN status = 'open' THEN 'opened'
  WHEN status = 'in_progress' THEN 'processing'
  WHEN status = 'resolved' THEN 'reply'
  ELSE status
END;

ALTER TABLE support_tickets
  MODIFY status ENUM('opened','processing','reply','closed') NOT NULL DEFAULT 'opened';
