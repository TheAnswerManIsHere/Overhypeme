-- Fact wording house style, Phase 2: the one-time pass (plan
-- docs/plans/PLAN_FACT_HOUSE_STYLE.md, *The one-time pass*, M1-M7; approved by
-- David 2026-11-24; Issue #1174, phase Issue #1219). A backfill; no schema change.
--
-- What it does, in one transaction:
-- 1. Brings every fact's wording (facts.text) to the house style: spacing
--    tidied, a capital first letter, terminal punctuation. Nothing between the
--    first letter and the ending changes; no grammar repair runs (M1).
-- 2. Lifts the wording lock (trigger facts_text_is_locked, migration 0141) for
--    this update only and restores it before the transaction commits: the
--    lock's single named exception (David, Q2: 1). A failure rolls back with
--    the lock in place (M2).
-- 3. For each changed fact, renders canonical_text afresh from the new wording,
--    so it equals renderCanonical(new text); a null stays null (M3). Tidying
--    the old canonical instead would not do: rendering and tidying do not
--    commute (`anti-{NAME}` -> `Anti-Alex`, PR #1221 round 1). The caption
--    split and has_pronouns are unchanged by the rule (factHouseStyle.test.ts).
-- 4. Records the pre-pass wording on each changed fact's draft gag-idea set
--    that lacks the record (visual_concept_candidates.factTextUsed), so the
--    freshness check keeps a current set current (M6).
-- 5. Tidies submitted_text of every review still awaiting a decision
--    (status 'pending'); decided reviews and submitted_text_original are
--    history and untouched (M4).
-- Memes are not touched: a baked image and a frozen caption never change, and
-- a meme that reads live wording follows its fact (David, Q6: 1; M5).
--
-- The rule here is pg_temp.house_style, the SQL twin of applyHouseStyle in
-- lib/api-zod/src/templateGrammar.ts, and the plain-name render is
-- pg_temp.house_style_render_canonical, the SQL twin of renderCanonical
-- (artifacts/api-server/src/lib/renderCanonical.ts) for its fixed identity. Its whitespace set is JavaScript's \s,
-- written out; its emoji set is JavaScript's Extended_Pictographic plus
-- Regional_Indicator, skin tones, U+FE0F, U+20E3, U+200D and tag characters,
-- generated from Node 22 (Unicode 17.0) as code-point ranges. Letter case
-- comes from the database's locale; it matches JavaScript over every Latin
-- letter (U+0000-U+024F) and can differ on a few letters of other scripts.
-- houseStyleParity.test.ts runs both over the rule's table, the emoji set over
-- every code point and capitalization over every Latin letter; the post-merge
-- check counts any fact the two still disagree on.
--
-- Row-state matrix (counts are RAISEd as a NOTICE):
--   fact already tidy                         -> no write
--   fact untidy                               -> text tidied; canonical rendered from it
--   fact untidy, canonical_text null          -> text tidied; canonical null
--   fact untidy, idea set without the record  -> record set to the old text
--   fact untidy, idea set with the record     -> record untouched
--   pending review untidy / tidy              -> tidied / no write
--   decided review                            -> untouched
-- A second run writes nothing.
--
-- Release precondition: Phase 1 (PR #1213) must already be the running release
-- wherever this runs, so every writer alive during the pass tidies too.
--
-- Recovery: forward only. The way back for one fact is a second sanctioned
-- migration; nothing else depends on the old spelling.

CREATE OR REPLACE FUNCTION pg_temp.house_style_upper_first(word text) RETURNS text
LANGUAGE plpgsql IMMUTABLE AS $fn$
DECLARE
  first text := substr(word, 1, 1);
  up text;
BEGIN
  IF first !~ '^[[:lower:]]$' THEN RETURN word; END IF;
  up := upper(first);
  -- One character that lowercases back to the letter: leaves a titlecase
  -- digraph (U+01C5) as written, as JavaScript does.
  IF length(up) <> 1 OR lower(up) <> first THEN RETURN word; END IF;
  RETURN up || substr(word, 2);
END;
$fn$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION pg_temp.house_style_start(t text) RETURNS text
LANGUAGE plpgsql IMMUTABLE AS $fn$
DECLARE
  n integer := length(t);
  i integer := 1;
  head text;
  rest text;
  close_at integer;
  inner_token text;
  after_token text;
  mapped text;
  first_word text;
BEGIN
  WHILE i <= n AND substr(t, i, 1) IN ('"', '''', '“', '‘', '(', '[', '«', '¿', '¡') LOOP
    i := i + 1;
  END LOOP;
  IF i > n THEN RETURN t; END IF;
  head := substr(t, 1, i - 1);
  rest := substr(t, i);

  IF substr(rest, 1, 1) = '{' THEN
    close_at := position('}' IN rest);
    IF close_at = 0 THEN RETURN t; END IF;
    inner_token := substr(rest, 2, close_at - 2);
    after_token := substr(rest, close_at + 1);
    mapped := CASE inner_token
      WHEN 'SUBJ' THEN 'Subj' WHEN 'OBJ' THEN 'Obj' WHEN 'POSS' THEN 'Poss'
      WHEN 'POSS_PRO' THEN 'Poss_Pro' WHEN 'REFL' THEN 'Refl'
      WHEN 'he' THEN 'He' WHEN 'him' THEN 'Him' WHEN 'his' THEN 'His'
      WHEN 'himself' THEN 'Himself' WHEN 'he''s' THEN 'He''s'
      ELSE NULL END;
    IF mapped IS NOT NULL THEN RETURN head || '{' || mapped || '}' || after_token; END IF;
    IF inner_token ~ '^[^|]+\|[^|]+$' THEN
      RETURN head || '{' || pg_temp.house_style_upper_first(split_part(inner_token, '|', 1))
        || '|' || pg_temp.house_style_upper_first(split_part(inner_token, '|', 2)) || '}' || after_token;
    END IF;
    RETURN t;
  END IF;

  first_word := coalesce(substring(rest FROM '^[^\t\n\v\f\r \u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF{]+'), '');
  IF substr(first_word, 2) ~ '[[:upper:]]' THEN RETURN t; END IF; -- Q3
  RETURN head || pg_temp.house_style_upper_first(rest);
END;
$fn$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION pg_temp.house_style_closes_single_quote(c text[], pos integer) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE AS $fn$
DECLARE
  open_count integer := 0;
  i integer;
  ch text;
  prev text;
  nxt text;
BEGIN
  FOR i IN 1 .. pos - 1 LOOP
    ch := c[i];
    prev := coalesce(c[i - 1], '');
    nxt := coalesce(c[i + 1], '');
    IF ch = '‘' OR (ch = '''' AND (i = 1 OR prev ~ '^[\t\n\v\f\r \u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF("“[]$') AND nxt <> '' AND nxt !~ '^[\t\n\v\f\r \u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]$') THEN
      open_count := open_count + 1;
      CONTINUE;
    END IF;
    IF ch IN ('''', '’') AND prev <> '' AND prev !~ '^[\t\n\v\f\r \u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]$' AND nxt !~ '^[[:alnum:]]$' AND open_count > 0 THEN
      open_count := open_count - 1;
    END IF;
  END LOOP;
  RETURN open_count > 0;
END;
$fn$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION pg_temp.house_style_end(t text) RETURNS text
LANGUAGE plpgsql IMMUTABLE AS $fn$
DECLARE
  c text[] := regexp_split_to_array(t, '');
  n integer := coalesce(array_length(c, 1), 0);
  lead integer := 0;
  probe integer;
  end_at integer;
  o integer;
  depth integer;
  j integer;
  body text;
  tail text;
  opener text;

BEGIN
  IF t = '' THEN RETURN t; END IF;
  WHILE lead < n AND c[lead + 1] IN ('"', '''', '“', '‘', '(', '[', '«', '¿', '¡') LOOP
    lead := lead + 1;
  END LOOP;

  -- Is a mark already there? Behind every trailing closing quote and bracket.
  probe := n;
  WHILE probe > 0 AND (
    c[probe] IN ('"', '”', '»', ')', ']')
    OR (c[probe] IN ('''', '’') AND pg_temp.house_style_closes_single_quote(c, probe))
  ) LOOP
    probe := probe - 1;
  END LOOP;
  IF probe = 0 THEN RETURN t; END IF;
  IF c[probe] IN ('.', '!', '?', '…') THEN RETURN t; END IF;
  IF c[probe] NOT IN ('©', '®', '™') AND array_to_string(c[1:probe], '') ~ '[\u00A9\u00AE\u200D\u203C\u2049\u20E3\u2122\u2139\u2194-\u2199\u21A9-\u21AA\u231A-\u231B\u2328\u23CF\u23E9-\u23F3\u23F8-\u23FA\u24C2\u25AA-\u25AB\u25B6\u25C0\u25FB-\u25FE\u2600-\u2604\u260E\u2611\u2614-\u2615\u2618\u261D\u2620\u2622-\u2623\u2626\u262A\u262E-\u262F\u2638-\u263A\u2640\u2642\u2648-\u2653\u265F-\u2660\u2663\u2665-\u2666\u2668\u267B\u267E-\u267F\u2692-\u2697\u2699\u269B-\u269C\u26A0-\u26A1\u26A7\u26AA-\u26AB\u26B0-\u26B1\u26BD-\u26BE\u26C4-\u26C5\u26C8\u26CE-\u26CF\u26D1\u26D3-\u26D4\u26E9-\u26EA\u26F0-\u26F5\u26F7-\u26FA\u26FD\u2702\u2705\u2708-\u270D\u270F\u2712\u2714\u2716\u271D\u2721\u2728\u2733-\u2734\u2744\u2747\u274C\u274E\u2753-\u2755\u2757\u2763-\u2764\u2795-\u2797\u27A1\u27B0\u27BF\u2934-\u2935\u2B05-\u2B07\u2B1B-\u2B1C\u2B50\u2B55\u3030\u303D\u3297\u3299\uFE0F\U0001F004\U0001F02C-\U0001F02F\U0001F094-\U0001F09F\U0001F0AF-\U0001F0B0\U0001F0C0\U0001F0CF-\U0001F0D0\U0001F0F6-\U0001F0FF\U0001F170-\U0001F171\U0001F17E-\U0001F17F\U0001F18E\U0001F191-\U0001F19A\U0001F1AE-\U0001F1FF\U0001F201-\U0001F20F\U0001F21A\U0001F22F\U0001F232-\U0001F23A\U0001F23C-\U0001F23F\U0001F249-\U0001F25F\U0001F266-\U0001F321\U0001F324-\U0001F393\U0001F396-\U0001F397\U0001F399-\U0001F39B\U0001F39E-\U0001F3F0\U0001F3F3-\U0001F3F5\U0001F3F7-\U0001F4FD\U0001F4FF-\U0001F53D\U0001F549-\U0001F54E\U0001F550-\U0001F567\U0001F56F-\U0001F570\U0001F573-\U0001F57A\U0001F587\U0001F58A-\U0001F58D\U0001F590\U0001F595-\U0001F596\U0001F5A4-\U0001F5A5\U0001F5A8\U0001F5B1-\U0001F5B2\U0001F5BC\U0001F5C2-\U0001F5C4\U0001F5D1-\U0001F5D3\U0001F5DC-\U0001F5DE\U0001F5E1\U0001F5E3\U0001F5E8\U0001F5EF\U0001F5F3\U0001F5FA-\U0001F64F\U0001F680-\U0001F6C5\U0001F6CB-\U0001F6D2\U0001F6D5-\U0001F6E5\U0001F6E9\U0001F6EB-\U0001F6F0\U0001F6F3-\U0001F6FF\U0001F7DA-\U0001F7FF\U0001F80C-\U0001F80F\U0001F848-\U0001F84F\U0001F85A-\U0001F85F\U0001F888-\U0001F88F\U0001F8AE-\U0001F8AF\U0001F8BC-\U0001F8BF\U0001F8C2-\U0001F8CF\U0001F8D9-\U0001F8FF\U0001F90C-\U0001F93A\U0001F93C-\U0001F945\U0001F947-\U0001F9FF\U0001FA58-\U0001FA5F\U0001FA6E-\U0001FAFF\U0001FC00-\U0001FFFD\U000E0020-\U000E007F]$' THEN RETURN t; END IF; -- Q4

  -- Where a new mark goes: inside closing quotes, and inside a bracket only
  -- when its own opener begins the fact.
  end_at := n;
  WHILE end_at > 0 LOOP
    IF c[end_at] IN ('"', '”', '»')
       OR (c[end_at] IN ('''', '’') AND pg_temp.house_style_closes_single_quote(c, end_at)) THEN
      end_at := end_at - 1;
      CONTINUE;
    END IF;
    IF c[end_at] IN (')', ']') THEN
      o := -1;
      depth := 0;
      IF c[end_at] = ')' THEN opener := '('; ELSE opener := '['; END IF;
      FOR j IN REVERSE end_at .. 1 LOOP
        IF c[j] = c[end_at] THEN
          depth := depth + 1;
        ELSIF c[j] = opener THEN
          depth := depth - 1;
          IF depth = 0 THEN o := j; EXIT; END IF;
        END IF;
      END LOOP;
      IF o >= 1 AND o <= lead THEN
        end_at := end_at - 1;
        CONTINUE;
      END IF;
    END IF;
    EXIT;
  END LOOP;

  body := array_to_string(c[1:end_at], '');
  tail := coalesce(array_to_string(c[end_at + 1:n], ''), '');
  IF right(body, 1) IN (',', ';', ':') THEN -- Q5
    RETURN left(body, -1) || '.' || tail;
  END IF;
  RETURN body || '.' || tail;
END;
$fn$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION pg_temp.house_style(t text) RETURNS text
LANGUAGE plpgsql IMMUTABLE AS $fn$
DECLARE
  spaced text;
BEGIN
  IF t IS NULL THEN RETURN NULL; END IF;
  spaced := regexp_replace(regexp_replace(t, '[\t\n\v\f\r \u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]+', ' ', 'g'), '^ | $', '', 'g');
  RETURN pg_temp.house_style_end(pg_temp.house_style_start(spaced));
END;
$fn$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION pg_temp.house_style_render_canonical(t text) RETURNS text
LANGUAGE plpgsql IMMUTABLE AS $fn$
DECLARE
  s text;
  done text := '';
  m text;
  inner_token text;
  rep text;
  p integer;
BEGIN
  IF t IS NULL THEN RETURN NULL; END IF;
  -- "a {NAME}" agrees with the name: "Alex" starts with a vowel, so "an";
  -- a capital A is kept. JavaScript's \b and \s, written out.
  s := regexp_replace(t, '(?<![A-Za-z0-9_])An?([\t\n\v\f\r \u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]+)\{NAME\}', 'An\1{NAME}', 'g');
  s := regexp_replace(s, '(?<![A-Za-z0-9_])an?([\t\n\v\f\r \u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]+)\{NAME\}', 'an\1{NAME}', 'g');
  -- Each innermost {…}, left to right, never rescanning what was put in.
  LOOP
    m := substring(s FROM '\{[^{}]+\}');
    EXIT WHEN m IS NULL;
    p := strpos(s, m);
    inner_token := substr(m, 2, length(m) - 2);
    rep := CASE inner_token
      WHEN 'NAME' THEN 'Alex' WHEN 'NAME_POSSESSIVE' THEN 'Alex''s'
      WHEN 'SUBJ' THEN 'they' WHEN 'Subj' THEN 'They'
      WHEN 'OBJ' THEN 'them' WHEN 'Obj' THEN 'Them'
      WHEN 'POSS' THEN 'their' WHEN 'Poss' THEN 'Their'
      WHEN 'POSS_PRO' THEN 'theirs' WHEN 'Poss_Pro' THEN 'Theirs'
      WHEN 'REFL' THEN 'themselves' WHEN 'Refl' THEN 'Themselves'
      ELSE NULL END;
    IF rep IS NULL THEN
      rep := CASE WHEN position('|' IN inner_token) > 0 THEN regexp_replace(inner_token, '^.*\|', '') ELSE m END;
    END IF;
    done := done || substr(s, 1, p - 1) || rep;
    s := substr(s, p + length(m));
  END LOOP;
  RETURN done || s;
END;
$fn$;--> statement-breakpoint

DO $$
DECLARE
  v_examined integer := 0;
  v_changed integer := 0;
  v_ideas integer := 0;
  v_reviews integer := 0;
BEGIN
  SELECT count(*) INTO v_examined FROM facts;

  DROP TABLE IF EXISTS pg_temp.house_style_pass;
  CREATE TEMP TABLE house_style_pass ON COMMIT DROP AS
    SELECT * FROM (SELECT id, text AS old_text, pg_temp.house_style(text) AS new_text FROM facts) s
    WHERE old_text IS DISTINCT FROM new_text;

  ALTER TABLE facts DISABLE TRIGGER facts_text_is_locked;

  UPDATE facts f
     SET text = p.new_text,
         canonical_text = CASE WHEN f.canonical_text IS NULL THEN NULL
                               ELSE pg_temp.house_style_render_canonical(p.new_text) END
    FROM house_style_pass p
   WHERE f.id = p.id;
  GET DIAGNOSTICS v_changed = ROW_COUNT;

  ALTER TABLE facts ENABLE TRIGGER facts_text_is_locked;

  UPDATE facts f
     SET visual_concept_candidates = jsonb_set(f.visual_concept_candidates, '{factTextUsed}', to_jsonb(p.old_text))
    FROM house_style_pass p
   WHERE f.id = p.id
     AND jsonb_typeof(f.visual_concept_candidates) = 'object'
     AND NOT (f.visual_concept_candidates ? 'factTextUsed');
  GET DIAGNOSTICS v_ideas = ROW_COUNT;

  -- One relation on purpose, the rule evaluated twice: a row a moderator edits
  -- or decides while this waits on its lock is rechecked as it now stands. A
  -- join to a snapshot copy wrote the old wording over the edit (PR #1221).
  UPDATE pending_reviews
     SET submitted_text = pg_temp.house_style(submitted_text)
   WHERE status = 'pending'
     AND submitted_text IS DISTINCT FROM pg_temp.house_style(submitted_text);
  GET DIAGNOSTICS v_reviews = ROW_COUNT;

  RAISE NOTICE '[0165] facts examined: %, changed: %, already tidy: %; draft idea sets recorded: %; pending submissions tidied: %',
    v_examined, v_changed, v_examined - v_changed, v_ideas, v_reviews;
END $$;
