-- A license that mirrors a Polar subscription. All four are NULL on hand-issued and free licenses.
ALTER TABLE licenses ADD COLUMN polar_subscription_id TEXT;
ALTER TABLE licenses ADD COLUMN polar_customer_id TEXT;   -- for the customer portal link
ALTER TABLE licenses ADD COLUMN polar_event_at INTEGER;   -- unix ms of the newest webhook applied, so a late retry can't undo a newer one
ALTER TABLE licenses ADD COLUMN account_email TEXT;       -- the website account that started the checkout; NULL when bought in the app
CREATE UNIQUE INDEX idx_licenses_polar_subscription ON licenses(polar_subscription_id);
