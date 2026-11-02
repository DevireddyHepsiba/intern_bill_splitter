CREATE TABLE homes (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL CONSTRAINT homes_name_not_blank CHECK (length(trim(name)) > 0)
);

CREATE TABLE members (
  id TEXT PRIMARY KEY NOT NULL,
  home_id TEXT NOT NULL,
  name TEXT NOT NULL CONSTRAINT members_name_not_blank CHECK (length(trim(name)) > 0),
  member_order INTEGER NOT NULL CONSTRAINT members_order_nonnegative CHECK (member_order >= 0),
  CONSTRAINT members_home_fk FOREIGN KEY (home_id) REFERENCES homes(id) ON DELETE CASCADE,
  CONSTRAINT members_home_order_unique UNIQUE (home_id, member_order),
  CONSTRAINT members_id_home_unique UNIQUE (id, home_id)
);

CREATE TABLE bills (
  id TEXT PRIMARY KEY NOT NULL,
  home_id TEXT NOT NULL,
  title TEXT NOT NULL CONSTRAINT bills_title_not_blank CHECK (length(trim(title)) > 0),
  total_cents INTEGER NOT NULL CONSTRAINT bills_total_positive CHECK (total_cents > 0),
  CONSTRAINT bills_home_fk FOREIGN KEY (home_id) REFERENCES homes(id) ON DELETE CASCADE,
  CONSTRAINT bills_id_home_unique UNIQUE (id, home_id)
);

CREATE TABLE shares (
  id TEXT PRIMARY KEY NOT NULL,
  bill_id TEXT NOT NULL,
  home_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CONSTRAINT shares_amount_nonnegative CHECK (amount_cents >= 0),
  paid_at TEXT,
  idempotency_key TEXT,
  CONSTRAINT shares_bill_home_fk FOREIGN KEY (bill_id, home_id) REFERENCES bills(id, home_id) ON DELETE CASCADE,
  CONSTRAINT shares_member_home_fk FOREIGN KEY (member_id, home_id) REFERENCES members(id, home_id) ON DELETE CASCADE,
  CONSTRAINT shares_paid_key_consistent CHECK ((paid_at IS NULL AND idempotency_key IS NULL) OR (paid_at IS NOT NULL AND idempotency_key IS NOT NULL)),
  CONSTRAINT shares_id_key_unique UNIQUE (id, bill_id)
);

CREATE INDEX members_by_home_order ON members(home_id, member_order);
CREATE INDEX bills_by_home ON bills(home_id);
CREATE INDEX shares_by_member_paid ON shares(member_id, paid_at);
CREATE INDEX shares_by_bill ON shares(bill_id);
