-- Licenses: one row per purchased license key.
CREATE TABLE licenses (
  key          TEXT PRIMARY KEY,                 -- e.g. "TF-ABCD-EFGH-IJKL"
  email        TEXT NOT NULL,
  plan         TEXT NOT NULL,                    -- "solo" | "pro" | "team"
  max_devices  INTEGER NOT NULL DEFAULT 1,       -- 1 for solo, 3 for pro, N for team
  status       TEXT NOT NULL DEFAULT 'active',   -- "active" | "revoked" | "expired"
  expires_at   INTEGER,                          -- unix ms; NULL = perpetual
  created_at   INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  notes        TEXT
);
CREATE INDEX idx_licenses_email ON licenses(email);

-- Activations: one row per (license, device). Enforces the max_devices limit.
CREATE TABLE activations (
  license_key   TEXT NOT NULL,
  device_id     TEXT NOT NULL,                   -- client-sent machine fingerprint
  device_label  TEXT,                            -- OS + hostname for the admin page
  app_version   TEXT,
  activated_at  INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  last_seen_at  INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  revoked_at    INTEGER,                         -- NULL if active on this device
  PRIMARY KEY (license_key, device_id),
  FOREIGN KEY (license_key) REFERENCES licenses(key) ON DELETE CASCADE
);
CREATE INDEX idx_activations_device ON activations(device_id);

-- Telemetry events: anonymous-ish usage pings (device_id is pseudonymous).
CREATE TABLE telemetry_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id   TEXT NOT NULL,
  license_key TEXT,
  app_version TEXT,
  os          TEXT,
  name        TEXT NOT NULL,                     -- "app.launch", "playbook.run", "tab.open", ...
  props       TEXT,                              -- JSON blob
  created_at  INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX idx_events_name_time ON telemetry_events(name, created_at);
CREATE INDEX idx_events_device ON telemetry_events(device_id);

-- Telemetry errors: unhandled rejections, replayer failures, proxy errors.
CREATE TABLE telemetry_errors (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id   TEXT NOT NULL,
  license_key TEXT,
  app_version TEXT,
  os          TEXT,
  kind        TEXT NOT NULL,                     -- "crash" | "playbook" | "proxy" | "ipc" | "generic"
  message     TEXT NOT NULL,
  stack       TEXT,
  context     TEXT,                              -- JSON blob
  created_at  INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX idx_errors_kind_time ON telemetry_errors(kind, created_at);
CREATE INDEX idx_errors_device ON telemetry_errors(device_id);
