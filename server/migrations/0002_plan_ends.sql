-- When a whole plan stops working (for example the free beta). No row means the plan has no end.
CREATE TABLE plan_ends (
  plan     TEXT PRIMARY KEY,
  ends_at  INTEGER NOT NULL   -- unix ms
);
