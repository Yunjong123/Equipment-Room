CREATE TABLE users (
  id uuid PRIMARY KEY,
  email text NOT NULL UNIQUE CHECK (email = lower(email)),
  name text NOT NULL,
  password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('member', 'staff')),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  sid text PRIMARY KEY,
  sess jsonb NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX sessions_expiry ON sessions (expires_at);

CREATE TABLE equipment (
  id uuid PRIMARY KEY,
  asset_tag text NOT NULL UNIQUE,
  name text NOT NULL,
  category text NOT NULL CHECK (category IN ('camera','audio','lighting','support','projector','accessory')),
  description text NOT NULL DEFAULT '',
  location text NOT NULL,
  condition text NOT NULL CHECK (condition IN ('ready','maintenance','retired')),
  condition_notes text NOT NULL DEFAULT '',
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX equipment_category ON equipment (category, condition);

CREATE TABLE bookings (
  id uuid PRIMARY KEY,
  equipment_id uuid NOT NULL REFERENCES equipment(id),
  user_id uuid NOT NULL REFERENCES users(id),
  start_date date NOT NULL,
  end_date date NOT NULL,
  purpose text NOT NULL,
  request_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved','checked_out','returned','cancelled','no_show')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  checked_out_at timestamptz,
  returned_at timestamptz,
  cancellation_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, request_id),
  UNIQUE (id, equipment_id),
  CHECK (end_date >= start_date AND end_date - start_date < 7),
  CHECK (status <> 'checked_out' OR checked_out_at IS NOT NULL),
  CHECK (status <> 'returned' OR (checked_out_at IS NOT NULL AND returned_at IS NOT NULL))
);
CREATE INDEX bookings_member ON bookings (user_id, created_at DESC);
CREATE INDEX bookings_equipment ON bookings (equipment_id, status, start_date);
CREATE UNIQUE INDEX one_open_loan ON bookings (equipment_id) WHERE status = 'checked_out';

CREATE TABLE booking_days (
  equipment_id uuid NOT NULL,
  day date NOT NULL,
  booking_id uuid NOT NULL,
  PRIMARY KEY (equipment_id, day),
  FOREIGN KEY (booking_id, equipment_id) REFERENCES bookings(id, equipment_id) ON DELETE CASCADE
);
CREATE INDEX booking_days_booking ON booking_days (booking_id, day);

CREATE TABLE issues (
  id uuid PRIMARY KEY,
  equipment_id uuid NOT NULL REFERENCES equipment(id),
  booking_id uuid,
  reporter_id uuid NOT NULL REFERENCES users(id),
  request_id uuid NOT NULL,
  description text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  resolution text,
  resolved_by uuid REFERENCES users(id),
  resolved_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (reporter_id, request_id),
  UNIQUE (id, equipment_id),
  FOREIGN KEY (booking_id, equipment_id) REFERENCES bookings(id, equipment_id),
  CHECK (status <> 'resolved' OR (resolution IS NOT NULL AND resolved_at IS NOT NULL))
);
CREATE INDEX issues_equipment ON issues (equipment_id, status);

CREATE TABLE photos (
  id uuid PRIMARY KEY,
  equipment_id uuid NOT NULL REFERENCES equipment(id),
  issue_id uuid,
  uploaded_by uuid NOT NULL REFERENCES users(id),
  upload_request_id uuid NOT NULL,
  source_hash text NOT NULL,
  UNIQUE (uploaded_by, upload_request_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (issue_id, equipment_id) REFERENCES issues(id, equipment_id)
);
CREATE INDEX photos_equipment ON photos (equipment_id, issue_id, created_at);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY,
  equipment_id uuid NOT NULL REFERENCES equipment(id),
  booking_id uuid,
  actor_id uuid NOT NULL REFERENCES users(id),
  action text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (booking_id, equipment_id) REFERENCES bookings(id, equipment_id)
);
CREATE INDEX audit_equipment ON audit_events (equipment_id, created_at DESC);
CREATE INDEX audit_booking ON audit_events (booking_id, created_at);
