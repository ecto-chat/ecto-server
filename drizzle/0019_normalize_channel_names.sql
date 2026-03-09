-- Normalize channel names
UPDATE channels SET name = TRIM(BOTH '-' FROM
  regexp_replace(regexp_replace(regexp_replace(
    lower(name), '[\s_]+', '-', 'g'),
    '[^a-z0-9-]', '', 'g'),
    '-{2,}', '-', 'g'))
WHERE name IS NOT NULL;

-- Fallback for names that became empty
UPDATE channels SET name = 'channel-' || substring(id::text, 1, 8)
WHERE name = '' OR name IS NULL;

-- Same for categories
UPDATE categories SET name = TRIM(BOTH '-' FROM
  regexp_replace(regexp_replace(regexp_replace(
    lower(name), '[\s_]+', '-', 'g'),
    '[^a-z0-9-]', '', 'g'),
    '-{2,}', '-', 'g'))
WHERE name IS NOT NULL;

UPDATE categories SET name = 'category-' || substring(id::text, 1, 8)
WHERE name = '' OR name IS NULL;
