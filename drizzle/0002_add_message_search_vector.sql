-- Add tsvector column for full-text search on messages
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "search_vector" tsvector
  GENERATED ALWAYS AS (to_tsvector('english', coalesce("content", ''))) STORED;

-- Create GIN index for fast full-text search
CREATE INDEX IF NOT EXISTS "idx_messages_search" ON "messages" USING gin ("search_vector");
