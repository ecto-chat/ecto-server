CREATE TABLE page_contents (
  channel_id UUID PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
  content TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  edited_by UUID,
  edited_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE page_revisions (
  id UUID PRIMARY KEY,
  channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  version INTEGER NOT NULL,
  edited_by UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_page_revisions_channel ON page_revisions(channel_id, version DESC);
