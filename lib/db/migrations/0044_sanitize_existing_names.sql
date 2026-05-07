-- Sweep existing user names through the new personal-name rules.
--
-- The validator on the application side enforces:
--   - Only Unicode letter / mark / number, plus apostrophe (') and hyphen (-).
--   - At most 3 whitespace-separated words.
--   - Each word at most 20 characters.
--   - Whitespace runs collapsed to a single space; trimmed.
--
-- This SQL approximation is intentionally coarse (PostgreSQL POSIX classes
-- cover the same letter / mark / number / digit shape we want via [:alpha:]
-- and [:digit:]). Per the project's "soft-cap" principle this only fires on
-- existing rows; the application validator is the source of truth going
-- forward.
--
-- Idempotent: running again does nothing because the second pass through
-- the regexp_replace produces the same output as the first pass.

-- Helper: drop disallowed chars, collapse whitespace, take first 3 words,
-- and cap each word at 20 chars. Implemented inline because we don't want
-- to ship a function we'd then have to manage.

UPDATE users
SET display_name = (
  WITH cleaned AS (
    SELECT trim(regexp_replace(
      regexp_replace(display_name, '[^[:alpha:][:digit:][:space:]''\-]', '', 'g'),
      '[[:space:]]+', ' ', 'g'
    )) AS s
  ),
  words AS (
    SELECT (regexp_split_to_array(s, ' '))[1:3] AS arr FROM cleaned
  )
  SELECT array_to_string(
    ARRAY(SELECT substring(unnest, 1, 20) FROM unnest(arr)),
    ' '
  )
  FROM words
)
WHERE display_name IS NOT NULL;

UPDATE users
SET first_name = (
  WITH cleaned AS (
    SELECT trim(regexp_replace(
      regexp_replace(first_name, '[^[:alpha:][:digit:][:space:]''\-]', '', 'g'),
      '[[:space:]]+', ' ', 'g'
    )) AS s
  ),
  words AS (
    SELECT (regexp_split_to_array(s, ' '))[1:3] AS arr FROM cleaned
  )
  SELECT array_to_string(
    ARRAY(SELECT substring(unnest, 1, 20) FROM unnest(arr)),
    ' '
  )
  FROM words
)
WHERE first_name IS NOT NULL;

UPDATE users
SET last_name = (
  WITH cleaned AS (
    SELECT trim(regexp_replace(
      regexp_replace(last_name, '[^[:alpha:][:digit:][:space:]''\-]', '', 'g'),
      '[[:space:]]+', ' ', 'g'
    )) AS s
  ),
  words AS (
    SELECT (regexp_split_to_array(s, ' '))[1:3] AS arr FROM cleaned
  )
  SELECT array_to_string(
    ARRAY(SELECT substring(unnest, 1, 20) FROM unnest(arr)),
    ' '
  )
  FROM words
)
WHERE last_name IS NOT NULL;

-- Pronouns: same shape but allows '/' as a word separator. Cap 4 tokens,
-- 20 chars per slash-separated part.
UPDATE users
SET pronouns = (
  WITH cleaned AS (
    SELECT trim(regexp_replace(
      regexp_replace(pronouns, '[^[:alpha:][:digit:][:space:]''\-/]', '', 'g'),
      '[[:space:]]+', ' ', 'g'
    )) AS s
  ),
  words AS (
    SELECT (regexp_split_to_array(s, ' '))[1:4] AS arr FROM cleaned
  )
  SELECT array_to_string(
    ARRAY(
      SELECT array_to_string(
        ARRAY(SELECT substring(p, 1, 20) FROM unnest(string_to_array(unnest, '/')) p),
        '/'
      )
      FROM unnest(arr)
    ),
    ' '
  )
  FROM words
)
WHERE pronouns IS NOT NULL;
