CREATE TABLE category_permission_overrides (
  id UUID PRIMARY KEY,
  category_id UUID NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  target_type VARCHAR(10) NOT NULL,
  target_id UUID NOT NULL,
  allow BIGINT NOT NULL DEFAULT 0,
  deny BIGINT NOT NULL DEFAULT 0,
  UNIQUE(category_id, target_type, target_id)
);
CREATE INDEX idx_category_perms_category ON category_permission_overrides(category_id);
