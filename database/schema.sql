CREATE DATABASE IF NOT EXISTS ironvault CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE ironvault;

CREATE TABLE IF NOT EXISTS admins (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  name VARCHAR(120) NOT NULL,
  email VARCHAR(190) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS membership_plans (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  name VARCHAR(80) NOT NULL UNIQUE,
  duration_months INT UNSIGNED NOT NULL,
  price_paise BIGINT UNSIGNED NOT NULL,
  description VARCHAR(500) NOT NULL DEFAULT '',
  features_json JSON NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS members (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  member_code VARCHAR(32) NOT NULL UNIQUE,
  full_name VARCHAR(160) NOT NULL,
  mobile VARCHAR(20) NOT NULL,
  email VARCHAR(190) NULL,
  age TINYINT UNSIGNED NULL,
  gender VARCHAR(30) NULL,
  preferred_program VARCHAR(100) NULL,
  joined_on DATE NOT NULL,
  archived BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_members_name (full_name),
  INDEX idx_members_mobile (mobile)
);

CREATE TABLE IF NOT EXISTS memberships (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  member_id BIGINT UNSIGNED NOT NULL,
  plan_id BIGINT UNSIGNED NULL,
  plan_name_snapshot VARCHAR(80) NOT NULL,
  duration_months INT UNSIGNED NOT NULL,
  fee_paise BIGINT UNSIGNED NOT NULL,
  start_date DATE NOT NULL,
  expiry_date DATE NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_memberships_member FOREIGN KEY (member_id) REFERENCES members(id),
  CONSTRAINT fk_memberships_plan FOREIGN KEY (plan_id) REFERENCES membership_plans(id) ON DELETE SET NULL,
  INDEX idx_memberships_expiry (expiry_date),
  INDEX idx_memberships_member (member_id, expiry_date)
);

CREATE TABLE IF NOT EXISTS invoices (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  member_id BIGINT UNSIGNED NOT NULL,
  membership_id BIGINT UNSIGNED NULL,
  amount_paise BIGINT UNSIGNED NOT NULL,
  due_date DATE NOT NULL,
  status ENUM('pending','paid','overdue','cancelled') NOT NULL DEFAULT 'pending',
  description VARCHAR(255) NOT NULL DEFAULT 'Membership fee',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_invoices_member FOREIGN KEY (member_id) REFERENCES members(id),
  CONSTRAINT fk_invoices_membership FOREIGN KEY (membership_id) REFERENCES memberships(id) ON DELETE SET NULL,
  INDEX idx_invoices_status_due (status, due_date)
);

CREATE TABLE IF NOT EXISTS payments (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  invoice_id BIGINT UNSIGNED NOT NULL,
  member_id BIGINT UNSIGNED NOT NULL,
  amount_paise BIGINT UNSIGNED NOT NULL,
  method ENUM('cash','upi','card','bank_transfer','other') NOT NULL,
  reference VARCHAR(190) NULL,
  recorded_by BIGINT UNSIGNED NULL,
  paid_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  note VARCHAR(500) NULL,
  CONSTRAINT fk_payments_invoice FOREIGN KEY (invoice_id) REFERENCES invoices(id),
  CONSTRAINT fk_payments_member FOREIGN KEY (member_id) REFERENCES members(id),
  CONSTRAINT fk_payments_admin FOREIGN KEY (recorded_by) REFERENCES admins(id) ON DELETE SET NULL,
  INDEX idx_payments_paid_at (paid_at)
);

CREATE TABLE IF NOT EXISTS follow_ups (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  member_id BIGINT UNSIGNED NOT NULL,
  note VARCHAR(1000) NOT NULL DEFAULT '',
  status ENUM('pending','contacted','completed') NOT NULL DEFAULT 'pending',
  next_follow_up DATE NULL,
  created_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_followups_member FOREIGN KEY (member_id) REFERENCES members(id),
  CONSTRAINT fk_followups_admin FOREIGN KEY (created_by) REFERENCES admins(id) ON DELETE SET NULL,
  INDEX idx_followups_status_date (status, next_follow_up)
);

CREATE TABLE IF NOT EXISTS reminder_queue (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  member_id BIGINT UNSIGNED NOT NULL,
  membership_id BIGINT UNSIGNED NOT NULL,
  channel ENUM('email','whatsapp','sms') NOT NULL,
  reminder_type ENUM('7_day','3_day','expiry_day','post_expiry') NOT NULL,
  scheduled_for DATETIME NOT NULL,
  status ENUM('pending','processing','sent','failed','cancelled','not_configured') NOT NULL DEFAULT 'pending',
  attempt_count INT UNSIGNED NOT NULL DEFAULT 0,
  provider_reference VARCHAR(190) NULL,
  last_error VARCHAR(1000) NULL,
  sent_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_reminders_member FOREIGN KEY (member_id) REFERENCES members(id),
  CONSTRAINT fk_reminders_membership FOREIGN KEY (membership_id) REFERENCES memberships(id),
  UNIQUE KEY uq_reminder_once (membership_id, channel, reminder_type),
  INDEX idx_reminders_status_schedule (status, scheduled_for)
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  admin_id BIGINT UNSIGNED NULL,
  action VARCHAR(100) NOT NULL,
  entity_type VARCHAR(80) NOT NULL,
  entity_id VARCHAR(80) NULL,
  details_json JSON NULL,
  ip_address VARCHAR(64) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_audit_admin FOREIGN KEY (admin_id) REFERENCES admins(id) ON DELETE SET NULL,
  INDEX idx_audit_created (created_at)
);

INSERT IGNORE INTO membership_plans (name, duration_months, price_paise, description, features_json) VALUES
('Basic', 1, 99900, 'A strong start to your fitness journey.', JSON_ARRAY('Gym floor access','Fitness orientation')),
('Premium', 3, 249900, 'A balanced plan for consistent progress.', JSON_ARRAY('Gym floor access','Fitness assessment','Group classes')),
('Pro', 6, 449900, 'More time to build lasting habits.', JSON_ARRAY('All Premium features','Progress reviews')),
('Elite', 12, 799900, 'Our best-value annual membership.', JSON_ARRAY('All Pro features','Priority session booking'));


CREATE TABLE IF NOT EXISTS contact_enquiries (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  name VARCHAR(120) NOT NULL,
  email VARCHAR(190) NOT NULL,
  phone VARCHAR(20) NULL,
  message VARCHAR(2000) NOT NULL,
  status ENUM('new','contacted','closed') NOT NULL DEFAULT 'new',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_enquiries_status_created (status, created_at)
);
