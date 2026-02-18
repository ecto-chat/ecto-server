ALTER TABLE server_config ADD COLUMN IF NOT EXISTS show_system_messages BOOLEAN NOT NULL DEFAULT true;
