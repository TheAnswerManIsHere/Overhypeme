--
-- PostgreSQL database dump
--

\restrict w99xrfkmfhq7w7RFi4yJqIbeG3c8vQwbd2MQeqrn1BtUyS34BKGpXe2PHarAzYn

-- Dumped from database version 16.10
-- Dumped by pg_dump version 16.10

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: drizzle; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA drizzle;


--
-- Name: drizzle_test; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA drizzle_test;


--
-- Name: heliumdb_test; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA heliumdb_test;


--
-- Name: stripe; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA stripe;


--
-- Name: vector; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;


--
-- Name: EXTENSION vector; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION vector IS 'vector data type and ivfflat and hnsw access methods';


--
-- Name: activity_type; Type: TYPE; Schema: heliumdb_test; Owner: -
--

CREATE TYPE heliumdb_test.activity_type AS ENUM (
    'fact_submitted',
    'fact_approved',
    'duplicate_flagged',
    'review_submitted',
    'review_approved',
    'review_rejected',
    'comment_posted',
    'comment_approved',
    'comment_rejected',
    'vote_cast',
    'system_message'
);


--
-- Name: affiliate_destination; Type: TYPE; Schema: heliumdb_test; Owner: -
--

CREATE TYPE heliumdb_test.affiliate_destination AS ENUM (
    'zazzle'
);


--
-- Name: affiliate_source_type; Type: TYPE; Schema: heliumdb_test; Owner: -
--

CREATE TYPE heliumdb_test.affiliate_source_type AS ENUM (
    'fact',
    'meme'
);


--
-- Name: membership_tier; Type: TYPE; Schema: heliumdb_test; Owner: -
--

CREATE TYPE heliumdb_test.membership_tier AS ENUM (
    'unregistered',
    'registered',
    'legendary'
);


--
-- Name: review_reason; Type: TYPE; Schema: heliumdb_test; Owner: -
--

CREATE TYPE heliumdb_test.review_reason AS ENUM (
    'duplicate',
    'spam',
    'offensive',
    'lame'
);


--
-- Name: review_status; Type: TYPE; Schema: heliumdb_test; Owner: -
--

CREATE TYPE heliumdb_test.review_status AS ENUM (
    'pending',
    'approved',
    'rejected'
);


--
-- Name: review_workflow_stage; Type: TYPE; Schema: heliumdb_test; Owner: -
--

CREATE TYPE heliumdb_test.review_workflow_stage AS ENUM (
    'triage_pending',
    'triage_rejected',
    'prep_pending',
    'prep_failed',
    'production_review',
    'production_rejected',
    'production_approved'
);


--
-- Name: video_job_status; Type: TYPE; Schema: heliumdb_test; Owner: -
--

CREATE TYPE heliumdb_test.video_job_status AS ENUM (
    'pending',
    'completed',
    'failed'
);


--
-- Name: activity_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.activity_type AS ENUM (
    'fact_submitted',
    'fact_approved',
    'duplicate_flagged',
    'review_submitted',
    'review_approved',
    'review_rejected',
    'comment_posted',
    'comment_approved',
    'comment_rejected',
    'vote_cast',
    'system_message'
);


--
-- Name: membership_tier; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.membership_tier AS ENUM (
    'unregistered',
    'registered',
    'legendary'
);


--
-- Name: review_reason; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.review_reason AS ENUM (
    'duplicate',
    'spam',
    'offensive',
    'lame'
);


--
-- Name: review_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.review_status AS ENUM (
    'pending',
    'approved',
    'rejected'
);


--
-- Name: review_workflow_stage; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.review_workflow_stage AS ENUM (
    'triage_pending',
    'triage_rejected',
    'prep_pending',
    'prep_failed',
    'concept_review',
    'production_review',
    'production_rejected',
    'production_approved'
);


--
-- Name: invoice_status; Type: TYPE; Schema: stripe; Owner: -
--

CREATE TYPE stripe.invoice_status AS ENUM (
    'draft',
    'open',
    'paid',
    'uncollectible',
    'void',
    'deleted'
);


--
-- Name: pricing_tiers; Type: TYPE; Schema: stripe; Owner: -
--

CREATE TYPE stripe.pricing_tiers AS ENUM (
    'graduated',
    'volume'
);


--
-- Name: pricing_type; Type: TYPE; Schema: stripe; Owner: -
--

CREATE TYPE stripe.pricing_type AS ENUM (
    'one_time',
    'recurring'
);


--
-- Name: subscription_schedule_status; Type: TYPE; Schema: stripe; Owner: -
--

CREATE TYPE stripe.subscription_schedule_status AS ENUM (
    'not_started',
    'active',
    'completed',
    'released',
    'canceled'
);


--
-- Name: subscription_status; Type: TYPE; Schema: stripe; Owner: -
--

CREATE TYPE stripe.subscription_status AS ENUM (
    'trialing',
    'active',
    'canceled',
    'incomplete',
    'incomplete_expired',
    'past_due',
    'unpaid',
    'paused'
);


--
-- Name: set_updated_at(); Type: FUNCTION; Schema: heliumdb_test; Owner: -
--

CREATE FUNCTION heliumdb_test.set_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  new._updated_at = now();
  return NEW;
end;
$$;


--
-- Name: set_updated_at_metadata(); Type: FUNCTION; Schema: heliumdb_test; Owner: -
--

CREATE FUNCTION heliumdb_test.set_updated_at_metadata() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  new.updated_at = now();
  return NEW;
end;
$$;


--
-- Name: backfill_feature_permissions(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.backfill_feature_permissions(p_migration_name text) RETURNS TABLE(inserted_count integer, already_complete_count integer, engine_experiments_skipped_count integer)
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_inserted integer := 0;
  v_already_complete integer := 0;
  v_skipped integer := 0;
  v_deleted jsonb;
  -- Rows retired by this plan. See the capture block below for why.
  --
  -- `meme_ai_background` is deliberately NOT here. It looks like a dead row —
  -- its only *reader* was an unreachable gate in render.ts — but the capability
  -- is real and reachable: the AI Background Picker's generate button hits four
  -- `requireLegendary` routes in memes.ts. That is the inline-role-check
  -- category this plan moves INTO the grid, not out of it.
  v_retired_keys text[] := ARRAY['meme_upload_photo'];
BEGIN
  -- Features already carrying a complete four-row set, measured BEFORE this
  -- run's inserts. This count legitimately RISES on a second run: the features
  -- the first run repaired are, by definition, complete on the second.
  SELECT count(*)::integer INTO v_already_complete
  FROM feature_flags f
  WHERE f.key <> 'engine_experiments'
    AND (
      SELECT count(*) FROM tier_feature_permissions p
      WHERE p.feature_key = f.key
        AND p.tier IN ('unregistered', 'registered', 'legendary', 'admin')
    ) = 4;

  -- How many rows the deliberate exception costs us. `engine_experiments` is
  -- left alone on purpose: backfilling a feature Plan 3 is about to retire is
  -- wasted work.
  -- Guarded on the feature actually existing: if `engine_experiments` is not a
  -- feature at all, the backfill would never have wanted those rows, and
  -- reporting 4 skipped would claim an exception that did no work.
  IF EXISTS (SELECT 1 FROM feature_flags WHERE key = 'engine_experiments') THEN
    SELECT greatest(0, 4 - count(*))::integer INTO v_skipped
    FROM tier_feature_permissions p
    WHERE p.feature_key = 'engine_experiments'
      AND p.tier IN ('unregistered', 'registered', 'legendary', 'admin');
  ELSE
    v_skipped := 0;
  END IF;

  -- Capture the vestigial row-sets before removing them, so recovery reads
  -- from the database. Only populated on the run that actually deletes
  -- something.
  --
  -- Only `meme_upload_photo` retires here — it encoded only the
  -- registered-vs-unregistered distinction authentication already enforces.
  -- `meme_ai_background` looked like the same shape (its only reader was the
  -- unreachable render.ts gate) but is deliberately KEPT, not retired: see
  -- the note above `v_retired_keys`.
  SELECT jsonb_build_object(
           'feature_flags', (
             SELECT coalesce(jsonb_agg(to_jsonb(f)), '[]'::jsonb)
             FROM feature_flags f WHERE f.key = ANY(v_retired_keys)
           ),
           'tier_feature_permissions', (
             SELECT coalesce(jsonb_agg(to_jsonb(p)), '[]'::jsonb)
             FROM tier_feature_permissions p WHERE p.feature_key = ANY(v_retired_keys)
           )
         )
    INTO v_deleted;

  IF v_deleted->'feature_flags' = '[]'::jsonb
     AND v_deleted->'tier_feature_permissions' = '[]'::jsonb THEN
    v_deleted := NULL;
  END IF;

  -- Children first, then the parent. Both are no-ops on a re-run and on an
  -- already-clean database.
  DELETE FROM tier_feature_permissions WHERE feature_key = ANY(v_retired_keys);
  DELETE FROM feature_flags WHERE key = ANY(v_retired_keys);

  -- Fill only the gaps. `false` is the correct default: it is exactly what the
  -- resolver already infers from a missing row, so filling a gap changes no
  -- behaviour.
  WITH wanted AS (
    SELECT f.key AS feature_key, t.tier
    FROM feature_flags f
    CROSS JOIN (VALUES ('unregistered'), ('registered'), ('legendary'), ('admin')) AS t(tier)
    WHERE f.key <> 'engine_experiments'
  ),
  missing AS (
    SELECT w.tier, w.feature_key
    FROM wanted w
    LEFT JOIN tier_feature_permissions p
      ON p.tier = w.tier AND p.feature_key = w.feature_key
    WHERE p.feature_key IS NULL
  ),
  ins AS (
    INSERT INTO tier_feature_permissions (tier, feature_key, enabled)
    SELECT tier, feature_key, false FROM missing
    ON CONFLICT (tier, feature_key) DO NOTHING
    RETURNING 1
  )
  SELECT count(*)::integer INTO v_inserted FROM ins;

  INSERT INTO feature_permissions_migration_log (
    migration_name, inserted_count, already_complete_count,
    engine_experiments_skipped_count, deleted_rows
  ) VALUES (
    p_migration_name, v_inserted, v_already_complete, v_skipped, v_deleted
  );

  RETURN QUERY SELECT v_inserted, v_already_complete, v_skipped;
END;
$$;


--
-- Name: entitlement_source_disputes_guard_absorbing(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.entitlement_source_disputes_guard_absorbing() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.is_terminal AND NOT NEW.is_terminal THEN
    RAISE EXCEPTION
      'entitlement_source_disputes.is_terminal is absorbing (dispute=%): % cannot revert to %',
      OLD.stripe_dispute_id, OLD.status, NEW.status
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: membership_entitlements_guard_immutable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.membership_entitlements_guard_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.source_type IS DISTINCT FROM OLD.source_type
     OR NEW.provider_ref IS DISTINCT FROM OLD.provider_ref
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION
      'membership_entitlements identity is frozen (id=%): user_id, source_type, provider_ref and created_at cannot be reassigned',
      OLD.id
      USING ERRCODE = '23514';
  END IF;

  IF OLD.dispute_loss_revoked_at IS NOT NULL
     AND NEW.dispute_loss_revoked_at IS DISTINCT FROM OLD.dispute_loss_revoked_at THEN
    RAISE EXCEPTION
      'membership_entitlements.dispute_loss_revoked_at is set-once (id=%): a lost chargeback revocation cannot be cleared or moved',
      OLD.id
      USING ERRCODE = '23514';
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;


--
-- Name: ncmec_reports_link_quarantine(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ncmec_reports_link_quarantine() RETURNS trigger
    LANGUAGE plpgsql
    AS $_$
DECLARE
  raw text;
BEGIN
  -- An explicit value always wins: the reconciler sets this column directly, and the
  -- trigger must never second-guess a caller that knows the linkage.
  IF NEW.quarantine_id IS NOT NULL THEN RETURN NEW; END IF;

  raw := NEW.request_metadata->>'quarantineId';
  -- Same bounded pattern as the backfill, for the same reason: a digit-only value can
  -- overflow bigint, and an exception here would abort the caller's quarantine transaction.
  IF raw IS NULL OR raw !~ '^[0-9]{1,18}$' THEN RETURN NEW; END IF;

  IF EXISTS (SELECT 1 FROM quarantined_memes q WHERE q.id = raw::bigint) THEN
    NEW.quarantine_id := raw::bigint;
  END IF;
  RETURN NEW;
END; $_$;


--
-- Name: ncmec_safety_audit_log_append_only(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ncmec_safety_audit_log_append_only() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'overhype_audit_maintenance')
     OR NOT pg_catalog.pg_has_role(current_user, 'overhype_audit_maintenance', 'usage') THEN
    RAISE EXCEPTION 'ncmec_safety_audit_log is append-only (%)', TG_OP
      USING HINT = 'An effective grant of overhype_audit_maintenance is required to modify this ledger.';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;


--
-- Name: set_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  new._updated_at = now();
  return NEW;
end;
$$;


--
-- Name: set_updated_at_metadata(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_updated_at_metadata() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  new.updated_at = now();
  return NEW;
end;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: __drizzle_migrations; Type: TABLE; Schema: drizzle; Owner: -
--

CREATE TABLE drizzle.__drizzle_migrations (
    id integer NOT NULL,
    hash text NOT NULL,
    created_at bigint
);


--
-- Name: __drizzle_migrations_id_seq; Type: SEQUENCE; Schema: drizzle; Owner: -
--

CREATE SEQUENCE drizzle.__drizzle_migrations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: __drizzle_migrations_id_seq; Type: SEQUENCE OWNED BY; Schema: drizzle; Owner: -
--

ALTER SEQUENCE drizzle.__drizzle_migrations_id_seq OWNED BY drizzle.__drizzle_migrations.id;


--
-- Name: __drizzle_migrations; Type: TABLE; Schema: drizzle_test; Owner: -
--

CREATE TABLE drizzle_test.__drizzle_migrations (
    id integer NOT NULL,
    hash text NOT NULL,
    created_at bigint
);


--
-- Name: __drizzle_migrations_id_seq; Type: SEQUENCE; Schema: drizzle_test; Owner: -
--

CREATE SEQUENCE drizzle_test.__drizzle_migrations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: __drizzle_migrations_id_seq; Type: SEQUENCE OWNED BY; Schema: drizzle_test; Owner: -
--

ALTER SEQUENCE drizzle_test.__drizzle_migrations_id_seq OWNED BY drizzle_test.__drizzle_migrations.id;


--
-- Name: activity_feed; Type: TABLE; Schema: heliumdb_test; Owner: -
--

CREATE TABLE heliumdb_test.activity_feed (
    id integer NOT NULL,
    user_id character varying NOT NULL,
    action_type heliumdb_test.activity_type NOT NULL,
    message text NOT NULL,
    metadata jsonb,
    read boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: activity_feed_id_seq; Type: SEQUENCE; Schema: heliumdb_test; Owner: -
--

CREATE SEQUENCE heliumdb_test.activity_feed_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: activity_feed_id_seq; Type: SEQUENCE OWNED BY; Schema: heliumdb_test; Owner: -
--

ALTER SEQUENCE heliumdb_test.activity_feed_id_seq OWNED BY heliumdb_test.activity_feed.id;


--
-- Name: admin_config; Type: TABLE; Schema: heliumdb_test; Owner: -
--

CREATE TABLE heliumdb_test.admin_config (
    key character varying(100) NOT NULL,
    value text NOT NULL,
    data_type character varying(20) DEFAULT 'integer'::character varying NOT NULL,
    label character varying(200) NOT NULL,
    description text,
    min_value integer,
    max_value integer,
    is_public boolean DEFAULT false NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by_id character varying,
    debug_value text,
    value_label text,
    debug_value_label text
);


--
-- Name: affiliate_clicks; Type: TABLE; Schema: heliumdb_test; Owner: -
--

CREATE TABLE heliumdb_test.affiliate_clicks (
    id integer NOT NULL,
    user_id character varying,
    source_type heliumdb_test.affiliate_source_type NOT NULL,
    source_id character varying NOT NULL,
    destination heliumdb_test.affiliate_destination NOT NULL,
    clicked_at timestamp with time zone DEFAULT now() NOT NULL,
    source character varying(64)
);


--
-- Name: affiliate_clicks_id_seq; Type: SEQUENCE; Schema: heliumdb_test; Owner: -
--

CREATE SEQUENCE heliumdb_test.affiliate_clicks_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: affiliate_clicks_id_seq; Type: SEQUENCE OWNED BY; Schema: heliumdb_test; Owner: -
--

ALTER SEQUENCE heliumdb_test.affiliate_clicks_id_seq OWNED BY heliumdb_test.affiliate_clicks.id;


--
-- Name: async_jobs; Type: TABLE; Schema: heliumdb_test; Owner: -
--

CREATE TABLE heliumdb_test.async_jobs (
    id integer NOT NULL,
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    max_attempts integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    queue character varying(64) NOT NULL,
    payload jsonb NOT NULL,
    external_id character varying(255),
    result jsonb,
    dedupe_key character varying(255)
);


--
-- Name: comments; Type: TABLE; Schema: heliumdb_test; Owner: -
--

CREATE TABLE heliumdb_test.comments (
    id integer NOT NULL,
    fact_id integer NOT NULL,
    author_id character varying,
    text text NOT NULL,
    flagged boolean DEFAULT false NOT NULL,
    flag_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    heart_count integer DEFAULT 0 NOT NULL
);


--
-- Name: comments_id_seq; Type: SEQUENCE; Schema: heliumdb_test; Owner: -
--

CREATE SEQUENCE heliumdb_test.comments_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: comments_id_seq; Type: SEQUENCE OWNED BY; Schema: heliumdb_test; Owner: -
--

ALTER SEQUENCE heliumdb_test.comments_id_seq OWNED BY heliumdb_test.comments.id;


--
-- Name: email_outbox_id_seq; Type: SEQUENCE; Schema: heliumdb_test; Owner: -
--

ALTER TABLE heliumdb_test.async_jobs ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME heliumdb_test.email_outbox_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: email_verification_tokens; Type: TABLE; Schema: heliumdb_test; Owner: -
--

CREATE TABLE heliumdb_test.email_verification_tokens (
    id integer NOT NULL,
    user_id character varying NOT NULL,
    token_hash text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    pending_email character varying
);


--
-- Name: email_verification_tokens_id_seq; Type: SEQUENCE; Schema: heliumdb_test; Owner: -
--

CREATE SEQUENCE heliumdb_test.email_verification_tokens_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: email_verification_tokens_id_seq; Type: SEQUENCE OWNED BY; Schema: heliumdb_test; Owner: -
--

ALTER SEQUENCE heliumdb_test.email_verification_tokens_id_seq OWNED BY heliumdb_test.email_verification_tokens.id;


--
-- Name: engines; Type: TABLE; Schema: heliumdb_test; Owner: -
--

CREATE TABLE heliumdb_test.engines (
    id character varying(64) NOT NULL,
    provider character varying(32) NOT NULL,
    endpoint_id character varying(128) NOT NULL,
    label character varying(128) NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    kind character varying(16) NOT NULL,
    tier_requirement character varying(32) DEFAULT 'legendary'::character varying NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    allowed_durations_sec jsonb,
    default_duration_sec integer,
    allowed_resolutions jsonb,
    default_resolution character varying(16),
    allowed_aspect_ratios jsonb,
    default_aspect_ratio character varying(16),
    supported_modes jsonb,
    default_mode character varying(32),
    audio_handling character varying(32) DEFAULT 'none'::character varying NOT NULL,
    param_schema jsonb NOT NULL,
    estimated_cost_usd_per_call numeric(10,6),
    estimated_cost_usd_per_second numeric(10,6),
    expected_run_ms integer DEFAULT 30000 NOT NULL,
    feature_flag_required character varying(64),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    default_temperature numeric(4,2),
    default_max_tokens integer,
    default_reasoning_effort character varying(16)
);


--
-- Name: enrichment_override_history; Type: TABLE; Schema: heliumdb_test; Owner: -
--

CREATE TABLE heliumdb_test.enrichment_override_history (
    id bigint NOT NULL,
    fact_id integer NOT NULL,
    path character varying(64) NOT NULL,
    action character varying(24) NOT NULL,
    old_value jsonb,
    new_value jsonb,
    ai_generation_id character varying(64),
    reason text,
    performed_by character varying,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: enrichment_override_history_id_seq; Type: SEQUENCE; Schema: heliumdb_test; Owner: -
--

CREATE SEQUENCE heliumdb_test.enrichment_override_history_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: enrichment_override_history_id_seq; Type: SEQUENCE OWNED BY; Schema: heliumdb_test; Owner: -
--

ALTER SEQUENCE heliumdb_test.enrichment_override_history_id_seq OWNED BY heliumdb_test.enrichment_override_history.id;


--
-- Name: external_links; Type: TABLE; Schema: heliumdb_test; Owner: -
--

CREATE TABLE heliumdb_test.external_links (
    id integer NOT NULL,
    fact_id integer NOT NULL,
    url text NOT NULL,
    title text,
    platform character varying(50),
    added_by_id character varying,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: external_links_id_seq; Type: SEQUENCE; Schema: heliumdb_test; Owner: -
--

CREATE SEQUENCE heliumdb_test.external_links_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: external_links_id_seq; Type: SEQUENCE OWNED BY; Schema: heliumdb_test; Owner: -
--

ALTER SEQUENCE heliumdb_test.external_links_id_seq OWNED BY heliumdb_test.external_links.id;


--
-- Name: fact_hashtags; Type: TABLE; Schema: heliumdb_test; Owner: -
--

CREATE TABLE heliumdb_test.fact_hashtags (
    fact_id integer NOT NULL,
    hashtag_id integer NOT NULL
);


--
-- Name: facts; Type: TABLE; Schema: heliumdb_test; Owner: -
--

CREATE TABLE heliumdb_test.facts (
    id integer NOT NULL,
    text text NOT NULL,
    submitted_by_id character varying,
    upvotes integer DEFAULT 0 NOT NULL,
    downvotes integer DEFAULT 0 NOT NULL,
    score integer DEFAULT 0 NOT NULL,
    comment_count integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    embedding public.vector(384),
    wilson_score double precision DEFAULT 0 NOT NULL,
    parent_id integer,
    use_case character varying(50),
    has_pronouns boolean DEFAULT false NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    canonical_text text,
    pexels_images jsonb,
    ai_scene_prompts jsonb,
    ai_meme_images jsonb,
    share_count integer DEFAULT 0 NOT NULL,
    split_token_index integer,
    enrichment jsonb,
    primary_archetype character varying(64),
    subtype character varying(64),
    overhype_fit character varying(16),
    adult_suitability character varying(24),
    enrichment_status character varying(16),
    enrichment_ai_derived jsonb,
    enrichment_overrides jsonb DEFAULT '{}'::jsonb NOT NULL,
    enrichment_baseline_changed boolean DEFAULT false NOT NULL,
    pexels_status character varying(16)
);


--
-- Name: facts_id_seq; Type: SEQUENCE; Schema: heliumdb_test; Owner: -
--

CREATE SEQUENCE heliumdb_test.facts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: facts_id_seq; Type: SEQUENCE OWNED BY; Schema: heliumdb_test; Owner: -
--

ALTER SEQUENCE heliumdb_test.facts_id_seq OWNED BY heliumdb_test.facts.id;


--
-- Name: fal_pricing_cache; Type: TABLE; Schema: heliumdb_test; Owner: -
--

CREATE TABLE heliumdb_test.fal_pricing_cache (
    endpoint_id text NOT NULL,
    unit_price numeric(12,6) NOT NULL,
    unit text NOT NULL,
    currency text DEFAULT 'USD'::text NOT NULL,
    fetched_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: feature_flags; Type: TABLE; Schema: heliumdb_test; Owner: -
--

CREATE TABLE heliumdb_test.feature_flags (
    key character varying(100) NOT NULL,
    display_name character varying(200) NOT NULL,
    description character varying(500),
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: hashtags; Type: TABLE; Schema: heliumdb_test; Owner: -
--

CREATE TABLE heliumdb_test.hashtags (
    id integer NOT NULL,
    name character varying(100) NOT NULL,
    fact_count integer DEFAULT 0 NOT NULL
);


--
-- Name: hashtags_id_seq; Type: SEQUENCE; Schema: heliumdb_test; Owner: -
--

CREATE SEQUENCE heliumdb_test.hashtags_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: hashtags_id_seq; Type: SEQUENCE OWNED BY; Schema: heliumdb_test; Owner: -
--

ALTER SEQUENCE heliumdb_test.hashtags_id_seq OWNED BY heliumdb_test.hashtags.id;


--
-- Name: hero_examples; Type: TABLE; Schema: heliumdb_test; Owner: -
--

CREATE TABLE heliumdb_test.hero_examples (
    id integer NOT NULL,
    artifact_type character varying(8) NOT NULL,
    asset_url text NOT NULL,
    poster_url text,
    caption_label text DEFAULT ''::text NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: hero_examples_id_seq; Type: SEQUENCE; Schema: heliumdb_test; Owner: -
--

CREATE SEQUENCE heliumdb_test.hero_examples_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: hero_examples_id_seq; Type: SEQUENCE OWNED BY; Schema: heliumdb_test; Owner: -
--

ALTER SEQUENCE heliumdb_test.hero_examples_id_seq OWNED BY heliumdb_test.hero_examples.id;


--
-- Name: image_prompt_attempts; Type: TABLE; Schema: heliumdb_test; Owner: -
--

CREATE TABLE heliumdb_test.image_prompt_attempts (
    id bigint NOT NULL,
    fact_id integer NOT NULL,
    user_id character varying,
    request_id character varying(128),
    render_job_id character varying(64),
    generation_mode character varying(8) NOT NULL,
    subject_render_mode character varying(32) NOT NULL,
    user_selected_subject_render_mode character varying(32),
    fallback_reason text,
    target_engine character varying(32) NOT NULL,
    source_image_analysis jsonb NOT NULL,
    source_image_sha256 character varying(64),
    identity_policy jsonb NOT NULL,
    render_controls jsonb NOT NULL,
    fact_enrichment_snapshot jsonb NOT NULL,
    archetype_strategy_version character varying(16) NOT NULL,
    visual_plan jsonb,
    compiled_prompt jsonb,
    subject_fact_compatibility jsonb,
    error text,
    generated_image_object_path text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    rendered_fact_text text
);


--
-- Name: image_prompt_attempts_id_seq; Type: SEQUENCE; Schema: heliumdb_test; Owner: -
--

CREATE SEQUENCE heliumdb_test.image_prompt_attempts_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: image_prompt_attempts_id_seq; Type: SEQUENCE OWNED BY; Schema: heliumdb_test; Owner: -
--

ALTER SEQUENCE heliumdb_test.image_prompt_attempts_id_seq OWNED BY heliumdb_test.image_prompt_attempts.id;


--
-- Name: lifetime_entitlements; Type: TABLE; Schema: heliumdb_test; Owner: -
--

CREATE TABLE heliumdb_test.lifetime_entitlements (
    id integer NOT NULL,
    user_id character varying NOT NULL,
    stripe_payment_intent_id character varying NOT NULL,
    stripe_customer_id character varying NOT NULL,
    amount integer,
    currency character varying DEFAULT 'usd'::character varying,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    status character varying DEFAULT 'active'::character varying NOT NULL,
    granted_by_admin_id character varying
);


--
-- Name: lifetime_entitlements_id_seq; Type: SEQUENCE; Schema: heliumdb_test; Owner: -
--

ALTER TABLE heliumdb_test.lifetime_entitlements ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME heliumdb_test.lifetime_entitlements_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: look_styles; Type: TABLE; Schema: heliumdb_test; Owner: -
--

CREATE TABLE heliumdb_test.look_styles (
    id character varying(64) NOT NULL,
    label character varying(128) NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    prompt_suffix text DEFAULT ''::text NOT NULL,
    prompt_suffix_reference text DEFAULT ''::text NOT NULL,
    preview_image_path text,
    sort_order integer DEFAULT 0 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: membership_history; Type: TABLE; Schema: heliumdb_test; Owner: -
--

CREATE TABLE heliumdb_test.membership_history (
    id integer NOT NULL,
    user_id character varying NOT NULL,
    event character varying NOT NULL,
    plan character varying,
    amount integer,
    currency character varying DEFAULT 'usd'::character varying,
    stripe_payment_intent_id character varying,
    stripe_subscription_id character varying,
    stripe_invoice_id character varying,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    stripe_dispute_id character varying,
    performed_by_admin_id character varying
);


--
-- Name: membership_history_id_seq; Type: SEQUENCE; Schema: heliumdb_test; Owner: -
--

ALTER TABLE heliumdb_test.membership_history ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME heliumdb_test.membership_history_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: memes; Type: TABLE; Schema: heliumdb_test; Owner: -
--

CREATE TABLE heliumdb_test.memes (
    id integer NOT NULL,
    fact_id integer NOT NULL,
    template_id character varying(50) NOT NULL,
    image_url text NOT NULL,
    permalink_slug character varying(16) NOT NULL,
    text_options jsonb,
    created_by_id character varying,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    image_source jsonb,
    is_public boolean DEFAULT true NOT NULL,
    is_low_res boolean DEFAULT false NOT NULL,
    original_width integer,
    original_height integer,
    upload_file_size_bytes integer,
    deleted_at timestamp with time zone,
    aspect_ratio character varying(20) DEFAULT 'landscape'::character varying NOT NULL,
    rendered_fact_text text,
    heart_count integer DEFAULT 0 NOT NULL,
    status character varying(20) DEFAULT 'live'::character varying NOT NULL,
    quarantine_reason text,
    nsfw_classifier_score numeric(6,4),
    is_nsfw boolean DEFAULT false NOT NULL,
    image_transform character varying(24),
    framing_transform jsonb,
    artifact_type character varying(10) DEFAULT 'image'::character varying NOT NULL,
    video_object_path text,
    video_job_id integer,
    look_style_id character varying(64),
    motion_preset_id character varying(64),
    CONSTRAINT memes_image_transform_chk CHECK (((image_transform IS NULL) OR ((image_transform)::text = ANY (ARRAY[('pulid'::character varying)::text, ('pulid_fallback_text'::character varying)::text]))))
);


--
-- Name: memes_id_seq; Type: SEQUENCE; Schema: heliumdb_test; Owner: -
--

CREATE SEQUENCE heliumdb_test.memes_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: memes_id_seq; Type: SEQUENCE OWNED BY; Schema: heliumdb_test; Owner: -
--

ALTER SEQUENCE heliumdb_test.memes_id_seq OWNED BY heliumdb_test.memes.id;


--
-- Name: motion_presets; Type: TABLE; Schema: heliumdb_test; Owner: -
--

CREATE TABLE heliumdb_test.motion_presets (
    id character varying(64) NOT NULL,
    label character varying(128) NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    motion_prompt text DEFAULT ''::text NOT NULL,
    gradient_from character varying(32) DEFAULT '#000000'::character varying NOT NULL,
    gradient_to character varying(32) DEFAULT '#333333'::character varying NOT NULL,
    preview_gif_path text,
    sort_order integer DEFAULT 0 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    camera_motion character varying(32),
    motion_intensity integer
);


--
-- Name: ncmec_reports; Type: TABLE; Schema: heliumdb_test; Owner: -
--

CREATE TABLE heliumdb_test.ncmec_reports (
    id bigint NOT NULL,
    report_id character varying(64),
    submitted_at timestamp with time zone,
    match_source character varying(16) NOT NULL,
    evidence_uri text NOT NULL,
    evidence_retention_until timestamp with time zone DEFAULT (now() + '90 days'::interval) NOT NULL,
    user_id character varying,
    request_metadata jsonb,
    submission_status character varying(16) DEFAULT 'pending'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: ncmec_reports_id_seq; Type: SEQUENCE; Schema: heliumdb_test; Owner: -
--

CREATE SEQUENCE heliumdb_test.ncmec_reports_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: ncmec_reports_id_seq; Type: SEQUENCE OWNED BY; Schema: heliumdb_test; Owner: -
--

ALTER SEQUENCE heliumdb_test.ncmec_reports_id_seq OWNED BY heliumdb_test.ncmec_reports.id;


--
-- Name: oauth_pending_states; Type: TABLE; Schema: heliumdb_test; Owner: -
--

CREATE TABLE heliumdb_test.oauth_pending_states (
    state character varying NOT NULL,
    code_verifier text NOT NULL,
    nonce text NOT NULL,
    return_to text DEFAULT '/'::text NOT NULL,
    is_popup boolean DEFAULT false NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    link_user_id character varying
);


--
-- Name: password_reset_tokens; Type: TABLE; Schema: heliumdb_test; Owner: -
--

CREATE TABLE heliumdb_test.password_reset_tokens (
    id integer NOT NULL,
    user_id character varying NOT NULL,
    token_hash text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: password_reset_tokens_id_seq; Type: SEQUENCE; Schema: heliumdb_test; Owner: -
--

CREATE SEQUENCE heliumdb_test.password_reset_tokens_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: password_reset_tokens_id_seq; Type: SEQUENCE OWNED BY; Schema: heliumdb_test; Owner: -
--

ALTER SEQUENCE heliumdb_test.password_reset_tokens_id_seq OWNED BY heliumdb_test.password_reset_tokens.id;


--
-- Name: pending_reviews; Type: TABLE; Schema: heliumdb_test; Owner: -
--

CREATE TABLE heliumdb_test.pending_reviews (
    id integer NOT NULL,
    submitted_text text NOT NULL,
    submitted_by_id character varying,
    matching_fact_id integer,
    matching_similarity integer DEFAULT 0 NOT NULL,
    hashtags jsonb DEFAULT '[]'::jsonb,
    status heliumdb_test.review_status DEFAULT 'pending'::heliumdb_test.review_status NOT NULL,
    admin_note text,
    reviewed_by_id character varying,
    approved_fact_id integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    reviewed_at timestamp with time zone,
    reason heliumdb_test.review_reason,
    enrichment jsonb,
    enrichment_status character varying(16),
    workflow_stage heliumdb_test.review_workflow_stage DEFAULT 'triage_pending'::heliumdb_test.review_workflow_stage NOT NULL,
    staging_fact_id integer,
    production_rejected_at timestamp with time zone,
    production_rejected_by_id character varying,
    production_rejection_note text
);


--
-- Name: pending_reviews_id_seq; Type: SEQUENCE; Schema: heliumdb_test; Owner: -
--

CREATE SEQUENCE heliumdb_test.pending_reviews_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: pending_reviews_id_seq; Type: SEQUENCE OWNED BY; Schema: heliumdb_test; Owner: -
--

ALTER SEQUENCE heliumdb_test.pending_reviews_id_seq OWNED BY heliumdb_test.pending_reviews.id;


--
-- Name: quarantined_memes; Type: TABLE; Schema: heliumdb_test; Owner: -
--

CREATE TABLE heliumdb_test.quarantined_memes (
    id bigint NOT NULL,
    meme_id integer,
    user_id character varying,
    evidence_object_path text NOT NULL,
    source character varying(20) NOT NULL,
    match_type character varying(10),
    classification character varying(40),
    classifier_score numeric(6,4),
    classifier_model text,
    raw_response jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: quarantined_memes_id_seq; Type: SEQUENCE; Schema: heliumdb_test; Owner: -
--

CREATE SEQUENCE heliumdb_test.quarantined_memes_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: quarantined_memes_id_seq; Type: SEQUENCE OWNED BY; Schema: heliumdb_test; Owner: -
--

ALTER SEQUENCE heliumdb_test.quarantined_memes_id_seq OWNED BY heliumdb_test.quarantined_memes.id;


--
-- Name: rate_limit_counters; Type: TABLE; Schema: heliumdb_test; Owner: -
--

CREATE TABLE heliumdb_test.rate_limit_counters (
    key_hash character varying(64) NOT NULL,
    key_raw text NOT NULL,
    count integer DEFAULT 0 NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: ratings; Type: TABLE; Schema: heliumdb_test; Owner: -
--

CREATE TABLE heliumdb_test.ratings (
    fact_id integer NOT NULL,
    user_id character varying NOT NULL,
    rating character varying(10) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: reactions; Type: TABLE; Schema: heliumdb_test; Owner: -
--

CREATE TABLE heliumdb_test.reactions (
    id integer NOT NULL,
    user_id character varying NOT NULL,
    target_type character varying(16) NOT NULL,
    target_id integer NOT NULL,
    reaction_type character varying(16) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: reactions_id_seq; Type: SEQUENCE; Schema: heliumdb_test; Owner: -
--

CREATE SEQUENCE heliumdb_test.reactions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: reactions_id_seq; Type: SEQUENCE OWNED BY; Schema: heliumdb_test; Owner: -
--

ALTER SEQUENCE heliumdb_test.reactions_id_seq OWNED BY heliumdb_test.reactions.id;


--
-- Name: reference_research_cache; Type: TABLE; Schema: heliumdb_test; Owner: -
--

CREATE TABLE heliumdb_test.reference_research_cache (
    cache_key character varying(128) NOT NULL,
    input jsonb NOT NULL,
    result jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone
);


--
-- Name: route_stat_events; Type: TABLE; Schema: heliumdb_test; Owner: -
--

CREATE TABLE heliumdb_test.route_stat_events (
    id integer NOT NULL,
    route_key character varying(50) NOT NULL,
    delta integer DEFAULT 1 NOT NULL,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: route_stat_events_id_seq; Type: SEQUENCE; Schema: heliumdb_test; Owner: -
--

CREATE SEQUENCE heliumdb_test.route_stat_events_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: route_stat_events_id_seq; Type: SEQUENCE OWNED BY; Schema: heliumdb_test; Owner: -
--

ALTER SEQUENCE heliumdb_test.route_stat_events_id_seq OWNED BY heliumdb_test.route_stat_events.id;


--
-- Name: route_stats; Type: TABLE; Schema: heliumdb_test; Owner: -
--

CREATE TABLE heliumdb_test.route_stats (
    route_key character varying(50) NOT NULL,
    visit_count integer DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: search_history; Type: TABLE; Schema: heliumdb_test; Owner: -
--

CREATE TABLE heliumdb_test.search_history (
    id integer NOT NULL,
    user_id character varying NOT NULL,
    query text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: search_history_id_seq; Type: SEQUENCE; Schema: heliumdb_test; Owner: -
--

CREATE SEQUENCE heliumdb_test.search_history_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: search_history_id_seq; Type: SEQUENCE OWNED BY; Schema: heliumdb_test; Owner: -
--

ALTER SEQUENCE heliumdb_test.search_history_id_seq OWNED BY heliumdb_test.search_history.id;


--
-- Name: sessions; Type: TABLE; Schema: heliumdb_test; Owner: -
--

CREATE TABLE heliumdb_test.sessions (
    sid character varying NOT NULL,
    sess jsonb NOT NULL,
    expire timestamp without time zone NOT NULL,
    user_id character varying
);


--
-- Name: share_intents; Type: TABLE; Schema: heliumdb_test; Owner: -
--

CREATE TABLE heliumdb_test.share_intents (
    id integer NOT NULL,
    meme_id integer NOT NULL,
    user_id character varying NOT NULL,
    platform character varying(20) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: share_intents_id_seq; Type: SEQUENCE; Schema: heliumdb_test; Owner: -
--

CREATE SEQUENCE heliumdb_test.share_intents_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: share_intents_id_seq; Type: SEQUENCE OWNED BY; Schema: heliumdb_test; Owner: -
--

ALTER SEQUENCE heliumdb_test.share_intents_id_seq OWNED BY heliumdb_test.share_intents.id;


--
-- Name: stripe_checkout_request_ledger; Type: TABLE; Schema: heliumdb_test; Owner: -
--

CREATE TABLE heliumdb_test.stripe_checkout_request_ledger (
    id integer NOT NULL,
    user_id character varying NOT NULL,
    price_id character varying NOT NULL,
    request_key character varying NOT NULL,
    session_id character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: stripe_checkout_request_ledger_id_seq; Type: SEQUENCE; Schema: heliumdb_test; Owner: -
--

ALTER TABLE heliumdb_test.stripe_checkout_request_ledger ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME heliumdb_test.stripe_checkout_request_ledger_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: stripe_processed_events; Type: TABLE; Schema: heliumdb_test; Owner: -
--

CREATE TABLE heliumdb_test.stripe_processed_events (
    event_id text NOT NULL,
    processed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: stripe_webhook_audit; Type: TABLE; Schema: heliumdb_test; Owner: -
--

CREATE TABLE heliumdb_test.stripe_webhook_audit (
    id integer NOT NULL,
    event_id text NOT NULL,
    event_type text NOT NULL,
    state character varying NOT NULL,
    detail text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: stripe_webhook_audit_id_seq; Type: SEQUENCE; Schema: heliumdb_test; Owner: -
--

ALTER TABLE heliumdb_test.stripe_webhook_audit ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME heliumdb_test.stripe_webhook_audit_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: subscriptions; Type: TABLE; Schema: heliumdb_test; Owner: -
--

CREATE TABLE heliumdb_test.subscriptions (
    id integer NOT NULL,
    user_id character varying NOT NULL,
    stripe_subscription_id character varying NOT NULL,
    stripe_customer_id character varying NOT NULL,
    plan character varying NOT NULL,
    status character varying NOT NULL,
    current_period_end timestamp with time zone,
    cancel_at_period_end boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: subscriptions_id_seq; Type: SEQUENCE; Schema: heliumdb_test; Owner: -
--

ALTER TABLE heliumdb_test.subscriptions ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME heliumdb_test.subscriptions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: tier_feature_permissions; Type: TABLE; Schema: heliumdb_test; Owner: -
--

CREATE TABLE heliumdb_test.tier_feature_permissions (
    tier character varying(50) NOT NULL,
    feature_key character varying(100) NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: transient_renders; Type: TABLE; Schema: heliumdb_test; Owner: -
--

CREATE TABLE heliumdb_test.transient_renders (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    endpoint character varying(16) NOT NULL,
    fact_id integer,
    user_id character varying,
    ip_hash text NOT NULL,
    mode character varying(24),
    result character varying(12) NOT NULL,
    rejection_reason text,
    latency_ms integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: upload_image_metadata; Type: TABLE; Schema: heliumdb_test; Owner: -
--

CREATE TABLE heliumdb_test.upload_image_metadata (
    object_path text NOT NULL,
    width integer NOT NULL,
    height integer NOT NULL,
    is_low_res boolean DEFAULT false NOT NULL,
    file_size_bytes integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    user_id character varying,
    arachnid_classification character varying(40),
    arachnid_match_type character varying(10),
    arachnid_sha1_base32 character varying(40),
    arachnid_sha256_hex character varying(64),
    arachnid_scanned_at timestamp with time zone,
    is_nsfw boolean DEFAULT false NOT NULL,
    transform character varying(24),
    source_object_path text,
    fact_id integer,
    transform_params_hash character varying(64),
    is_profile boolean DEFAULT false NOT NULL,
    source_image_analysis jsonb,
    source_image_analysis_version character varying(16),
    CONSTRAINT uim_transform_chk CHECK (((transform IS NULL) OR ((transform)::text = ANY (ARRAY[('pulid'::character varying)::text, ('pulid_fallback_text'::character varying)::text]))))
);


--
-- Name: user_ai_images; Type: TABLE; Schema: heliumdb_test; Owner: -
--

CREATE TABLE heliumdb_test.user_ai_images (
    id integer NOT NULL,
    user_id character varying NOT NULL,
    fact_id integer NOT NULL,
    gender character varying(10) NOT NULL,
    storage_path text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    image_type character varying(20) DEFAULT 'generic'::character varying NOT NULL
);


--
-- Name: user_ai_images_id_seq; Type: SEQUENCE; Schema: heliumdb_test; Owner: -
--

CREATE SEQUENCE heliumdb_test.user_ai_images_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: user_ai_images_id_seq; Type: SEQUENCE OWNED BY; Schema: heliumdb_test; Owner: -
--

ALTER SEQUENCE heliumdb_test.user_ai_images_id_seq OWNED BY heliumdb_test.user_ai_images.id;


--
-- Name: user_fact_preferences; Type: TABLE; Schema: heliumdb_test; Owner: -
--

CREATE TABLE heliumdb_test.user_fact_preferences (
    id integer NOT NULL,
    user_id character varying NOT NULL,
    fact_id integer NOT NULL,
    image_index integer DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    ai_meme_image_index integer DEFAULT 0 NOT NULL,
    last_seen_as_hero_at timestamp with time zone
);


--
-- Name: user_fact_preferences_id_seq; Type: SEQUENCE; Schema: heliumdb_test; Owner: -
--

CREATE SEQUENCE heliumdb_test.user_fact_preferences_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: user_fact_preferences_id_seq; Type: SEQUENCE OWNED BY; Schema: heliumdb_test; Owner: -
--

ALTER SEQUENCE heliumdb_test.user_fact_preferences_id_seq OWNED BY heliumdb_test.user_fact_preferences.id;


--
-- Name: user_generation_costs; Type: TABLE; Schema: heliumdb_test; Owner: -
--

CREATE TABLE heliumdb_test.user_generation_costs (
    id integer NOT NULL,
    user_id text NOT NULL,
    job_type text NOT NULL,
    endpoint_id text NOT NULL,
    unit_price_at_creation numeric(12,6) NOT NULL,
    billing_units numeric(12,4) NOT NULL,
    computed_cost_usd numeric(10,4) NOT NULL,
    pricing_fetched_at timestamp with time zone NOT NULL,
    job_reference_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: user_generation_costs_id_seq; Type: SEQUENCE; Schema: heliumdb_test; Owner: -
--

CREATE SEQUENCE heliumdb_test.user_generation_costs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: user_generation_costs_id_seq; Type: SEQUENCE OWNED BY; Schema: heliumdb_test; Owner: -
--

ALTER SEQUENCE heliumdb_test.user_generation_costs_id_seq OWNED BY heliumdb_test.user_generation_costs.id;


--
-- Name: users; Type: TABLE; Schema: heliumdb_test; Owner: -
--

CREATE TABLE heliumdb_test.users (
    id character varying DEFAULT gen_random_uuid() NOT NULL,
    email character varying,
    first_name character varying,
    last_name character varying,
    profile_image_url character varying,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    captcha_verified boolean DEFAULT false NOT NULL,
    is_admin boolean DEFAULT false NOT NULL,
    stripe_customer_id character varying,
    membership_tier heliumdb_test.membership_tier DEFAULT 'registered'::heliumdb_test.membership_tier NOT NULL,
    password_hash character varying,
    pronouns character varying(80) DEFAULT 'he/him'::character varying,
    is_active boolean DEFAULT true NOT NULL,
    display_name character varying,
    email_verified_at timestamp with time zone,
    pending_email character varying,
    avatar_style character varying(30) DEFAULT 'bottts'::character varying,
    avatar_source character varying(10) DEFAULT 'avatar'::character varying,
    monthly_generation_limit_override_usd numeric(10,4),
    admin_notifications boolean DEFAULT true NOT NULL,
    dispute_notifications boolean DEFAULT true NOT NULL,
    google_linked boolean DEFAULT false NOT NULL,
    apple_linked boolean DEFAULT false NOT NULL,
    nsfw_mode_enabled boolean DEFAULT false NOT NULL
);


--
-- Name: video_jobs; Type: TABLE; Schema: heliumdb_test; Owner: -
--

CREATE TABLE heliumdb_test.video_jobs (
    id integer NOT NULL,
    fact_id integer NOT NULL,
    image_url text NOT NULL,
    video_url text,
    status heliumdb_test.video_job_status DEFAULT 'pending'::heliumdb_test.video_job_status NOT NULL,
    ip_address character varying(45) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    fal_request_id text,
    motion_prompt text,
    is_private boolean DEFAULT false NOT NULL,
    user_id text,
    stylized_still_object_path text,
    video_engine_id character varying(64),
    image_engine_id character varying(64),
    subtitle_engine_id character varying(64),
    look_style_id text,
    motion_preset_id text,
    engine_mode character varying(32),
    custom_mode_prompt text,
    source_mode character varying(32),
    options_snapshot jsonb,
    stage1_cost_usd numeric(10,6),
    stage2_cost_usd numeric(10,6),
    stage3_cost_usd numeric(10,6),
    error_code character varying(64),
    error_message text,
    checkpoint_at timestamp with time zone,
    proceeded_at timestamp with time zone,
    completed_at timestamp with time zone
);


--
-- Name: video_jobs_id_seq; Type: SEQUENCE; Schema: heliumdb_test; Owner: -
--

CREATE SEQUENCE heliumdb_test.video_jobs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: video_jobs_id_seq; Type: SEQUENCE OWNED BY; Schema: heliumdb_test; Owner: -
--

ALTER SEQUENCE heliumdb_test.video_jobs_id_seq OWNED BY heliumdb_test.video_jobs.id;


--
-- Name: activity_feed; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.activity_feed (
    id integer NOT NULL,
    user_id character varying NOT NULL,
    action_type public.activity_type NOT NULL,
    message text NOT NULL,
    metadata jsonb,
    read boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: activity_feed_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.activity_feed_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: activity_feed_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.activity_feed_id_seq OWNED BY public.activity_feed.id;


--
-- Name: admin_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_config (
    key character varying(100) NOT NULL,
    value text NOT NULL,
    data_type character varying(20) DEFAULT 'integer'::character varying NOT NULL,
    label character varying(200) NOT NULL,
    description text,
    min_value integer,
    max_value integer,
    is_public boolean DEFAULT false NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by_id character varying,
    value_label text
);


--
-- Name: async_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.async_jobs (
    id integer NOT NULL,
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    max_attempts integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    queue character varying(64) NOT NULL,
    payload jsonb NOT NULL,
    external_id character varying(255),
    result jsonb,
    dedupe_key character varying(255)
);


--
-- Name: comments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.comments (
    id integer NOT NULL,
    fact_id integer NOT NULL,
    author_id character varying,
    text text NOT NULL,
    flagged boolean DEFAULT false NOT NULL,
    flag_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    heart_count integer DEFAULT 0 NOT NULL
);


--
-- Name: comments_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.comments_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: comments_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.comments_id_seq OWNED BY public.comments.id;


--
-- Name: email_outbox_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.async_jobs ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.email_outbox_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: email_verification_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.email_verification_tokens (
    id integer NOT NULL,
    user_id character varying NOT NULL,
    token_hash text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    pending_email character varying
);


--
-- Name: email_verification_tokens_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.email_verification_tokens_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: email_verification_tokens_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.email_verification_tokens_id_seq OWNED BY public.email_verification_tokens.id;


--
-- Name: engine_revision_bumps; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.engine_revision_bumps (
    id bigint NOT NULL,
    old_revision integer NOT NULL,
    new_revision integer NOT NULL,
    note text,
    performed_by character varying,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: engine_revision_bumps_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.engine_revision_bumps_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: engine_revision_bumps_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.engine_revision_bumps_id_seq OWNED BY public.engine_revision_bumps.id;


--
-- Name: engines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.engines (
    id character varying(64) NOT NULL,
    provider character varying(32) NOT NULL,
    endpoint_id character varying(128) NOT NULL,
    label character varying(128) NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    kind character varying(16) NOT NULL,
    tier_requirement character varying(32) DEFAULT 'legendary'::character varying NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    allowed_resolutions jsonb,
    default_resolution character varying(16),
    allowed_aspect_ratios jsonb,
    default_aspect_ratio character varying(16),
    param_schema jsonb NOT NULL,
    estimated_cost_usd_per_call numeric(10,6),
    expected_run_ms integer DEFAULT 30000 NOT NULL,
    feature_flag_required character varying(64),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    default_temperature numeric(4,2),
    default_max_tokens integer,
    default_reasoning_effort character varying(16)
);


--
-- Name: enrichment_override_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.enrichment_override_history (
    id bigint NOT NULL,
    fact_id integer NOT NULL,
    path character varying(64) NOT NULL,
    action character varying(24) NOT NULL,
    old_value jsonb,
    new_value jsonb,
    ai_generation_id character varying(64),
    reason text,
    performed_by character varying,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: enrichment_override_history_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.enrichment_override_history_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: enrichment_override_history_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.enrichment_override_history_id_seq OWNED BY public.enrichment_override_history.id;


--
-- Name: entitlement_grid_revision; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.entitlement_grid_revision (
    id integer DEFAULT 1 NOT NULL,
    revision bigint DEFAULT 0 NOT NULL,
    CONSTRAINT entitlement_grid_revision_singleton CHECK ((id = 1))
);


--
-- Name: entitlement_source_disputes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.entitlement_source_disputes (
    stripe_dispute_id character varying NOT NULL,
    source_id integer NOT NULL,
    status character varying(32) NOT NULL,
    is_terminal boolean NOT NULL,
    first_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at timestamp with time zone,
    CONSTRAINT entitlement_source_disputes_status_valid CHECK (((status)::text = ANY ((ARRAY['warning_needs_response'::character varying, 'warning_under_review'::character varying, 'warning_closed'::character varying, 'needs_response'::character varying, 'under_review'::character varying, 'won'::character varying, 'lost'::character varying, 'prevented'::character varying])::text[]))),
    CONSTRAINT entitlement_source_disputes_terminal_consistent CHECK ((is_terminal = ((status)::text = ANY ((ARRAY['won'::character varying, 'lost'::character varying, 'warning_closed'::character varying, 'prevented'::character varying])::text[]))))
);


--
-- Name: eval_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.eval_runs (
    id bigint NOT NULL,
    label text,
    run_profile jsonb,
    created_by character varying,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: eval_runs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.eval_runs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: eval_runs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.eval_runs_id_seq OWNED BY public.eval_runs.id;


--
-- Name: external_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.external_links (
    id integer NOT NULL,
    fact_id integer NOT NULL,
    url text NOT NULL,
    title text,
    platform character varying(50),
    added_by_id character varying,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: external_links_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.external_links_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: external_links_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.external_links_id_seq OWNED BY public.external_links.id;


--
-- Name: fact_enrichment_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fact_enrichment_versions (
    id bigint NOT NULL,
    fact_id integer NOT NULL,
    version_no integer NOT NULL,
    status character varying(16) NOT NULL,
    enrichment jsonb,
    enrichment_ai_derived jsonb,
    enrichment_overrides jsonb DEFAULT '{}'::jsonb NOT NULL,
    visual_override jsonb,
    fact_text_hash text,
    signature jsonb,
    source character varying(24) NOT NULL,
    source_review_id integer,
    note text,
    created_by character varying,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    promoted_at timestamp with time zone,
    superseded_at timestamp with time zone,
    rejected_at timestamp with time zone
);


--
-- Name: fact_enrichment_versions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.fact_enrichment_versions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: fact_enrichment_versions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.fact_enrichment_versions_id_seq OWNED BY public.fact_enrichment_versions.id;


--
-- Name: fact_hashtags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fact_hashtags (
    fact_id integer NOT NULL,
    hashtag_id integer NOT NULL
);


--
-- Name: fact_text_edit_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fact_text_edit_history (
    id bigint NOT NULL,
    fact_id integer NOT NULL,
    old_text text NOT NULL,
    new_text text NOT NULL,
    reason text NOT NULL,
    performed_by character varying,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: fact_text_edit_history_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.fact_text_edit_history_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: fact_text_edit_history_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.fact_text_edit_history_id_seq OWNED BY public.fact_text_edit_history.id;


--
-- Name: facts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.facts (
    id integer NOT NULL,
    text text NOT NULL,
    submitted_by_id character varying,
    upvotes integer DEFAULT 0 NOT NULL,
    downvotes integer DEFAULT 0 NOT NULL,
    score integer DEFAULT 0 NOT NULL,
    comment_count integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    embedding public.vector(384),
    wilson_score double precision DEFAULT 0 NOT NULL,
    parent_id integer,
    use_case character varying(50),
    has_pronouns boolean DEFAULT false NOT NULL,
    is_active boolean DEFAULT false NOT NULL,
    canonical_text text,
    ai_scene_prompts jsonb,
    ai_meme_images jsonb,
    share_count integer DEFAULT 0 NOT NULL,
    split_token_index integer,
    enrichment jsonb,
    primary_archetype character varying(64),
    subtype character varying(64),
    overhype_fit character varying(16),
    adult_suitability character varying(24),
    enrichment_status character varying(16),
    enrichment_ai_derived jsonb,
    enrichment_overrides jsonb DEFAULT '{}'::jsonb NOT NULL,
    enrichment_baseline_changed boolean DEFAULT false NOT NULL,
    last_processed_signature jsonb,
    visual_concept_candidates jsonb,
    visual_concept_status character varying(16),
    eval_golden boolean DEFAULT false NOT NULL,
    eval_golden_reason text,
    ai_meme_backfill_status character varying(16),
    CONSTRAINT facts_active_requires_concept CHECK (((is_active = false) OR COALESCE(((jsonb_typeof((enrichment #> '{visualPromptStrategyOverride,coreSceneOverride}'::text[])) = 'string'::text) AND ((enrichment #>> '{visualPromptStrategyOverride,coreSceneOverride}'::text[]) ~ '\S'::text)), false)))
);


--
-- Name: facts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.facts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: facts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.facts_id_seq OWNED BY public.facts.id;


--
-- Name: fal_pricing_cache; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fal_pricing_cache (
    endpoint_id text NOT NULL,
    unit_price numeric(12,6) NOT NULL,
    unit text NOT NULL,
    currency text DEFAULT 'USD'::text NOT NULL,
    fetched_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: feature_flags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.feature_flags (
    key character varying(100) NOT NULL,
    display_name character varying(200) NOT NULL,
    description character varying(500),
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: feature_permissions_migration_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.feature_permissions_migration_log (
    id integer NOT NULL,
    migration_name character varying(200) NOT NULL,
    inserted_count integer DEFAULT 0 NOT NULL,
    already_complete_count integer DEFAULT 0 NOT NULL,
    engine_experiments_skipped_count integer DEFAULT 0 NOT NULL,
    deleted_rows jsonb,
    ran_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: feature_permissions_migration_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.feature_permissions_migration_log_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: feature_permissions_migration_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.feature_permissions_migration_log_id_seq OWNED BY public.feature_permissions_migration_log.id;


--
-- Name: hashtags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hashtags (
    id integer NOT NULL,
    name character varying(100) NOT NULL,
    fact_count integer DEFAULT 0 NOT NULL
);


--
-- Name: hashtags_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.hashtags_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: hashtags_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.hashtags_id_seq OWNED BY public.hashtags.id;


--
-- Name: image_prompt_attempts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.image_prompt_attempts (
    id bigint NOT NULL,
    fact_id integer NOT NULL,
    user_id character varying,
    request_id character varying(128),
    render_job_id character varying(64),
    generation_mode character varying(8) NOT NULL,
    subject_render_mode character varying(32) NOT NULL,
    user_selected_subject_render_mode character varying(32),
    fallback_reason text,
    target_engine character varying(32) NOT NULL,
    source_image_analysis jsonb NOT NULL,
    source_image_sha256 character varying(64),
    identity_policy jsonb NOT NULL,
    render_controls jsonb NOT NULL,
    fact_enrichment_snapshot jsonb NOT NULL,
    archetype_strategy_version character varying(16) NOT NULL,
    visual_plan jsonb,
    compiled_prompt jsonb,
    subject_fact_compatibility jsonb,
    error text,
    generated_image_object_path text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    rendered_fact_text text,
    review_id integer,
    review_render_scenario_key character varying(40),
    review_render_input_hash character varying(64),
    review_reference_asset_version character varying(32),
    review_reference_identity_type character varying(32),
    review_render_batch_id character varying(64),
    moderator_rating smallint,
    failure_tag character varying(16),
    eval_notes text,
    eval_by character varying,
    eval_at timestamp with time zone,
    eval_run_id bigint,
    eval_scenario_key character varying(40),
    eval_input_hash text,
    error_code character varying(64)
);


--
-- Name: image_prompt_attempts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.image_prompt_attempts_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: image_prompt_attempts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.image_prompt_attempts_id_seq OWNED BY public.image_prompt_attempts.id;


--
-- Name: look_styles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.look_styles (
    id character varying(64) NOT NULL,
    label character varying(128) NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    prompt_suffix text DEFAULT ''::text NOT NULL,
    prompt_suffix_reference text DEFAULT ''::text NOT NULL,
    preview_image_path text,
    sort_order integer DEFAULT 0 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: membership_entitlements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.membership_entitlements (
    id integer NOT NULL,
    user_id character varying NOT NULL,
    source_type character varying(32) NOT NULL,
    provider_ref character varying,
    is_membership_product boolean,
    lifecycle_status character varying(32) NOT NULL,
    plan character varying,
    current_period_end timestamp with time zone,
    cancel_at_period_end boolean,
    amount integer,
    currency character varying,
    grace_started_at timestamp with time zone,
    grace_expires_at timestamp with time zone,
    dispute_loss_revoked_at timestamp with time zone,
    granted_by_admin_id character varying,
    granted_by_admin_label text,
    grant_reason text,
    revoked_by_admin_id character varying,
    revoked_by_admin_label text,
    revoked_reason text,
    revoked_at timestamp with time zone,
    source_state_as_of bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT membership_entitlements_allowlist_shape CHECK (((((source_type)::text = 'admin_grant'::text) AND (is_membership_product IS NULL)) OR (((source_type)::text <> 'admin_grant'::text) AND (is_membership_product IS NOT NULL)))),
    CONSTRAINT membership_entitlements_amount_shape CHECK ((((source_type)::text = 'stripe_lifetime_payment'::text) OR ((amount IS NULL) AND (currency IS NULL)))),
    CONSTRAINT membership_entitlements_grace_window_paired CHECK ((((grace_started_at IS NULL) AND (grace_expires_at IS NULL)) OR ((grace_started_at IS NOT NULL) AND (grace_expires_at IS NOT NULL)))),
    CONSTRAINT membership_entitlements_grant_provenance CHECK ((((source_type)::text <> 'admin_grant'::text) OR ((granted_by_admin_label IS NOT NULL) AND (grant_reason IS NOT NULL)))),
    CONSTRAINT membership_entitlements_grant_provenance_scope CHECK ((((source_type)::text = 'admin_grant'::text) OR ((granted_by_admin_id IS NULL) AND (granted_by_admin_label IS NULL) AND (grant_reason IS NULL)))),
    CONSTRAINT membership_entitlements_lifecycle_status_valid CHECK (((((source_type)::text = 'stripe_subscription'::text) AND ((lifecycle_status)::text = ANY ((ARRAY['active'::character varying, 'trialing'::character varying, 'past_due'::character varying, 'unpaid'::character varying, 'canceled'::character varying, 'incomplete'::character varying, 'incomplete_expired'::character varying, 'paused'::character varying])::text[]))) OR (((source_type)::text = 'stripe_lifetime_payment'::text) AND ((lifecycle_status)::text = ANY ((ARRAY['active'::character varying, 'refunded'::character varying])::text[]))) OR (((source_type)::text = 'admin_grant'::text) AND ((lifecycle_status)::text = ANY ((ARRAY['active'::character varying, 'revoked'::character varying])::text[]))))),
    CONSTRAINT membership_entitlements_provider_ref_shape CHECK (((((source_type)::text = 'admin_grant'::text) AND (provider_ref IS NULL)) OR (((source_type)::text <> 'admin_grant'::text) AND (provider_ref IS NOT NULL)))),
    CONSTRAINT membership_entitlements_revoke_provenance CHECK (((NOT (((source_type)::text = 'admin_grant'::text) AND ((lifecycle_status)::text = 'revoked'::text))) OR ((revoked_by_admin_label IS NOT NULL) AND (revoked_reason IS NOT NULL) AND (revoked_at IS NOT NULL)))),
    CONSTRAINT membership_entitlements_revoke_provenance_scope CHECK (((((source_type)::text = 'admin_grant'::text) AND ((lifecycle_status)::text = 'revoked'::text)) OR ((revoked_by_admin_id IS NULL) AND (revoked_by_admin_label IS NULL) AND (revoked_reason IS NULL) AND (revoked_at IS NULL)))),
    CONSTRAINT membership_entitlements_source_type_valid CHECK (((source_type)::text = ANY ((ARRAY['stripe_subscription'::character varying, 'stripe_lifetime_payment'::character varying, 'admin_grant'::character varying])::text[]))),
    CONSTRAINT membership_entitlements_subscription_only_columns CHECK ((((source_type)::text = 'stripe_subscription'::text) OR ((plan IS NULL) AND (current_period_end IS NULL) AND (cancel_at_period_end IS NULL) AND (grace_started_at IS NULL) AND (grace_expires_at IS NULL))))
);


--
-- Name: membership_entitlements_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.membership_entitlements ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.membership_entitlements_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: membership_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.membership_history (
    id integer NOT NULL,
    user_id character varying NOT NULL,
    event character varying NOT NULL,
    plan character varying,
    amount integer,
    currency character varying DEFAULT 'usd'::character varying,
    stripe_payment_intent_id character varying,
    stripe_subscription_id character varying,
    stripe_invoice_id character varying,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    stripe_dispute_id character varying,
    performed_by_admin_id character varying
);


--
-- Name: membership_history_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.membership_history ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.membership_history_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: membership_lease_fence_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.membership_lease_fence_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: membership_leases; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.membership_leases (
    scope character varying(200) NOT NULL,
    holder character varying(200) NOT NULL,
    fence bigint NOT NULL,
    acquired_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL
);


--
-- Name: membership_source_state_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.membership_source_state_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: memes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.memes (
    id integer NOT NULL,
    fact_id integer NOT NULL,
    template_id character varying(50) NOT NULL,
    image_url text NOT NULL,
    permalink_slug character varying(16) NOT NULL,
    text_options jsonb,
    created_by_id character varying,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    image_source jsonb,
    is_public boolean DEFAULT true NOT NULL,
    is_low_res boolean DEFAULT false NOT NULL,
    original_width integer,
    original_height integer,
    upload_file_size_bytes integer,
    deleted_at timestamp with time zone,
    aspect_ratio character varying(20) DEFAULT 'landscape'::character varying NOT NULL,
    rendered_fact_text text,
    heart_count integer DEFAULT 0 NOT NULL,
    status character varying(20) DEFAULT 'live'::character varying NOT NULL,
    quarantine_reason text,
    nsfw_classifier_score numeric(6,4),
    is_nsfw boolean DEFAULT false NOT NULL,
    image_transform character varying(24),
    framing_transform jsonb,
    artifact_type character varying(10) DEFAULT 'image'::character varying NOT NULL,
    CONSTRAINT memes_image_transform_chk CHECK (((image_transform IS NULL) OR ((image_transform)::text = ANY ((ARRAY['pulid'::character varying, 'pulid_fallback_text'::character varying])::text[]))))
);


--
-- Name: memes_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.memes_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: memes_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.memes_id_seq OWNED BY public.memes.id;


--
-- Name: ncmec_reports; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ncmec_reports (
    id bigint NOT NULL,
    report_id character varying(64),
    submitted_at timestamp with time zone,
    match_source character varying(16) NOT NULL,
    evidence_uri text NOT NULL,
    evidence_retention_until timestamp with time zone DEFAULT (now() + '90 days'::interval) NOT NULL,
    user_id character varying,
    request_metadata jsonb,
    submission_status character varying(16) DEFAULT 'pending'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    finish_started_at timestamp with time zone,
    attempt_count integer DEFAULT 0 NOT NULL,
    last_error text,
    last_error_code integer,
    submission_environment character varying(16),
    uploaded_files jsonb,
    retracted_at timestamp with time zone,
    submission_lease_owner text,
    submission_lease_until timestamp with time zone,
    manually_filed_at timestamp with time zone,
    test_submitted_at timestamp with time zone,
    test_submission_started_at timestamp with time zone,
    test_report_id character varying(64),
    quarantine_id bigint,
    failed_at timestamp with time zone,
    last_attempt_failed_at timestamp with time zone,
    alert_notified_at timestamp with time zone,
    content_origin character varying(16),
    reporter_snapshot jsonb,
    backlog_audited_at timestamp with time zone,
    backlog_audit_note text,
    identity_omission_approved_at timestamp with time zone,
    manual_report_id character varying(64),
    CONSTRAINT ncmec_reports_content_origin_check CHECK (((content_origin IS NULL) OR ((content_origin)::text = ANY ((ARRAY['generated'::character varying, 'user_upload'::character varying, 'stock'::character varying, 'template'::character varying, 'identity'::character varying])::text[])))),
    CONSTRAINT ncmec_reports_submission_status_check CHECK (((submission_status)::text = ANY ((ARRAY['pending'::character varying, 'in_progress'::character varying, 'submitted'::character varying, 'filed_manually'::character varying, 'failed'::character varying, 'not_reportable'::character varying])::text[])))
);


--
-- Name: COLUMN ncmec_reports.manual_report_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ncmec_reports.manual_report_id IS 'CyberTipline id an operator TYPED for a hand-filed report. Never read by the duplicate-filing guard — that reads report_id only.';


--
-- Name: ncmec_reports_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.ncmec_reports_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: ncmec_reports_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.ncmec_reports_id_seq OWNED BY public.ncmec_reports.id;


--
-- Name: ncmec_safety_audit_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ncmec_safety_audit_log (
    id bigint NOT NULL,
    report_id bigint,
    actor_user_id character varying,
    actor_label text NOT NULL,
    action character varying(40) NOT NULL,
    reason text,
    before_state jsonb,
    after_state jsonb,
    attempt_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ncmec_safety_audit_log_action_check CHECK (((action)::text = ANY ((ARRAY['retry'::character varying, 'send_to_test_started'::character varying, 'send_to_test_completed'::character varying, 'backlog_audit'::character varying, 'approve_identity_omission'::character varying, 'mark_manually_filed'::character varying, 'correct_manual_filing'::character varying, 'reopen'::character varying, 'config_write'::character varying])::text[])))
);


--
-- Name: ncmec_safety_audit_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.ncmec_safety_audit_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: ncmec_safety_audit_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.ncmec_safety_audit_log_id_seq OWNED BY public.ncmec_safety_audit_log.id;


--
-- Name: oauth_pending_states; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.oauth_pending_states (
    state character varying NOT NULL,
    code_verifier text NOT NULL,
    nonce text NOT NULL,
    return_to text DEFAULT '/'::text NOT NULL,
    is_popup boolean DEFAULT false NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    link_user_id character varying
);


--
-- Name: password_reset_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.password_reset_tokens (
    id integer NOT NULL,
    user_id character varying NOT NULL,
    token_hash text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: password_reset_tokens_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.password_reset_tokens_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: password_reset_tokens_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.password_reset_tokens_id_seq OWNED BY public.password_reset_tokens.id;


--
-- Name: pending_reviews; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pending_reviews (
    id integer NOT NULL,
    submitted_text text NOT NULL,
    submitted_by_id character varying,
    matching_fact_id integer,
    matching_similarity integer DEFAULT 0 NOT NULL,
    hashtags jsonb DEFAULT '[]'::jsonb,
    status public.review_status DEFAULT 'pending'::public.review_status NOT NULL,
    admin_note text,
    reviewed_by_id character varying,
    approved_fact_id integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    reviewed_at timestamp with time zone,
    reason public.review_reason,
    enrichment jsonb,
    enrichment_status character varying(16),
    workflow_stage public.review_workflow_stage DEFAULT 'triage_pending'::public.review_workflow_stage NOT NULL,
    staging_fact_id integer,
    production_rejected_at timestamp with time zone,
    production_rejected_by_id character varying,
    production_rejection_note text,
    visual_render_approval_waiver jsonb,
    candidate_version_id bigint,
    parent_fact_id integer
);


--
-- Name: pending_reviews_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.pending_reviews_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: pending_reviews_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.pending_reviews_id_seq OWNED BY public.pending_reviews.id;


--
-- Name: quarantined_memes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.quarantined_memes (
    id bigint NOT NULL,
    meme_id integer,
    user_id character varying,
    evidence_object_path text NOT NULL,
    source character varying(20) NOT NULL,
    match_type character varying(10),
    classification character varying(40),
    classifier_score numeric(6,4),
    classifier_model text,
    raw_response jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    content_origin character varying(16),
    report_intent boolean,
    reporter_snapshot jsonb,
    request_metadata jsonb,
    CONSTRAINT quarantined_memes_content_origin_check CHECK (((content_origin IS NULL) OR ((content_origin)::text = ANY ((ARRAY['generated'::character varying, 'user_upload'::character varying, 'stock'::character varying, 'template'::character varying, 'identity'::character varying])::text[]))))
);


--
-- Name: COLUMN quarantined_memes.report_intent; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.quarantined_memes.report_intent IS 'Reportability decision frozen at quarantine time. NULL means pre-migration/unknowable — NOT false.';


--
-- Name: quarantined_memes_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.quarantined_memes_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: quarantined_memes_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.quarantined_memes_id_seq OWNED BY public.quarantined_memes.id;


--
-- Name: rate_limit_counters; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.rate_limit_counters (
    key_hash character varying(64) NOT NULL,
    key_raw text NOT NULL,
    count integer DEFAULT 0 NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: reactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reactions (
    id integer NOT NULL,
    user_id character varying NOT NULL,
    target_type character varying(16) NOT NULL,
    target_id integer NOT NULL,
    reaction_type character varying(16) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: reactions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.reactions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: reactions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.reactions_id_seq OWNED BY public.reactions.id;


--
-- Name: reference_research_cache; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reference_research_cache (
    cache_key character varying(128) NOT NULL,
    input jsonb NOT NULL,
    result jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone
);


--
-- Name: search_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.search_history (
    id integer NOT NULL,
    user_id character varying NOT NULL,
    query text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: search_history_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.search_history_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: search_history_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.search_history_id_seq OWNED BY public.search_history.id;


--
-- Name: sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sessions (
    sid character varying NOT NULL,
    sess jsonb NOT NULL,
    expire timestamp without time zone NOT NULL,
    user_id character varying
);


--
-- Name: share_intents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.share_intents (
    id integer NOT NULL,
    meme_id integer NOT NULL,
    user_id character varying NOT NULL,
    platform character varying(20) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: share_intents_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.share_intents_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: share_intents_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.share_intents_id_seq OWNED BY public.share_intents.id;


--
-- Name: stripe_checkout_request_ledger; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stripe_checkout_request_ledger (
    id integer NOT NULL,
    user_id character varying NOT NULL,
    price_id character varying NOT NULL,
    request_key character varying NOT NULL,
    session_id character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: stripe_checkout_request_ledger_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.stripe_checkout_request_ledger ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.stripe_checkout_request_ledger_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: stripe_processed_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stripe_processed_events (
    event_id text NOT NULL,
    processed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: stripe_webhook_audit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stripe_webhook_audit (
    id integer NOT NULL,
    event_id text NOT NULL,
    event_type text NOT NULL,
    state character varying NOT NULL,
    detail text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: stripe_webhook_audit_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.stripe_webhook_audit ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.stripe_webhook_audit_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: tier_feature_permission_audit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tier_feature_permission_audit (
    id integer NOT NULL,
    actor_id text,
    tier character varying(50) NOT NULL,
    feature_key character varying(100) NOT NULL,
    enabled_before boolean,
    enabled_after boolean NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: tier_feature_permission_audit_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tier_feature_permission_audit_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tier_feature_permission_audit_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tier_feature_permission_audit_id_seq OWNED BY public.tier_feature_permission_audit.id;


--
-- Name: tier_feature_permissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tier_feature_permissions (
    tier character varying(50) NOT NULL,
    feature_key character varying(100) NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: transient_renders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.transient_renders (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    endpoint character varying(16) NOT NULL,
    fact_id integer,
    user_id character varying,
    ip_hash text NOT NULL,
    mode character varying(24),
    result character varying(12) NOT NULL,
    rejection_reason text,
    latency_ms integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: upload_image_metadata; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.upload_image_metadata (
    object_path text NOT NULL,
    width integer NOT NULL,
    height integer NOT NULL,
    is_low_res boolean DEFAULT false NOT NULL,
    file_size_bytes integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    user_id character varying,
    arachnid_classification character varying(40),
    arachnid_match_type character varying(10),
    arachnid_sha1_base32 character varying(40),
    arachnid_sha256_hex character varying(64),
    arachnid_scanned_at timestamp with time zone,
    is_nsfw boolean DEFAULT false NOT NULL,
    transform character varying(24),
    source_object_path text,
    fact_id integer,
    transform_params_hash character varying(64),
    is_profile boolean DEFAULT false NOT NULL,
    source_image_analysis jsonb,
    source_image_analysis_version character varying(16),
    CONSTRAINT uim_transform_chk CHECK (((transform IS NULL) OR ((transform)::text = ANY ((ARRAY['pulid'::character varying, 'pulid_fallback_text'::character varying])::text[]))))
);


--
-- Name: user_ai_images; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_ai_images (
    id integer NOT NULL,
    user_id character varying NOT NULL,
    fact_id integer NOT NULL,
    gender character varying(10) NOT NULL,
    storage_path text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    image_type character varying(20) DEFAULT 'generic'::character varying NOT NULL
);


--
-- Name: user_ai_images_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.user_ai_images_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: user_ai_images_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.user_ai_images_id_seq OWNED BY public.user_ai_images.id;


--
-- Name: user_fact_preferences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_fact_preferences (
    id integer NOT NULL,
    user_id character varying NOT NULL,
    fact_id integer NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_as_hero_at timestamp with time zone
);


--
-- Name: user_fact_preferences_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.user_fact_preferences_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: user_fact_preferences_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.user_fact_preferences_id_seq OWNED BY public.user_fact_preferences.id;


--
-- Name: user_generation_costs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_generation_costs (
    id integer NOT NULL,
    user_id text NOT NULL,
    job_type text NOT NULL,
    endpoint_id text NOT NULL,
    unit_price_at_creation numeric(12,6) NOT NULL,
    billing_units numeric(12,4) NOT NULL,
    computed_cost_usd numeric(10,4) NOT NULL,
    pricing_fetched_at timestamp with time zone NOT NULL,
    job_reference_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    is_estimated boolean
);


--
-- Name: COLUMN user_generation_costs.is_estimated; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.user_generation_costs.is_estimated IS 'Cost provenance. false = derived from fal''s published rate for the endpoint; true = derived from an operator-configured estimate or hard-coded fallback; NULL = unrecoverable for this historical row, or written by a build predating the flag. NOT measured-vs-estimated: no row holds an actual provider charge. When true, pricing_fetched_at is the write time, not a fetch time.';


--
-- Name: user_generation_costs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.user_generation_costs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: user_generation_costs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.user_generation_costs_id_seq OWNED BY public.user_generation_costs.id;


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id character varying DEFAULT gen_random_uuid() NOT NULL,
    email character varying,
    first_name character varying,
    last_name character varying,
    profile_image_url character varying,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    captcha_verified boolean DEFAULT false NOT NULL,
    is_admin boolean DEFAULT false NOT NULL,
    stripe_customer_id character varying,
    membership_tier public.membership_tier DEFAULT 'registered'::public.membership_tier NOT NULL,
    password_hash character varying,
    pronouns character varying(80) DEFAULT 'he/him'::character varying,
    is_active boolean DEFAULT true NOT NULL,
    display_name character varying,
    email_verified_at timestamp with time zone,
    pending_email character varying,
    avatar_style character varying(30) DEFAULT 'bottts'::character varying,
    avatar_source character varying(10) DEFAULT 'avatar'::character varying,
    monthly_generation_limit_override_usd numeric(10,4),
    admin_notifications boolean DEFAULT true NOT NULL,
    dispute_notifications boolean DEFAULT true NOT NULL,
    google_linked boolean DEFAULT false NOT NULL,
    apple_linked boolean DEFAULT false NOT NULL,
    nsfw_mode_enabled boolean DEFAULT false NOT NULL,
    membership_valid_until timestamp with time zone
);


--
-- Name: worker_lane_heartbeats; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.worker_lane_heartbeats (
    instance_id character varying(64) NOT NULL,
    lane character varying(32) NOT NULL,
    worker_protocol_version integer NOT NULL,
    last_scheduled_at timestamp with time zone DEFAULT now() NOT NULL,
    last_tick_completed_at timestamp with time zone,
    in_flight_count integer DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: _managed_webhooks; Type: TABLE; Schema: stripe; Owner: -
--

CREATE TABLE stripe._managed_webhooks (
    id text NOT NULL,
    object text,
    url text NOT NULL,
    enabled_events jsonb NOT NULL,
    description text,
    enabled boolean,
    livemode boolean,
    metadata jsonb,
    secret text NOT NULL,
    status text,
    api_version text,
    created integer,
    updated_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    last_synced_at timestamp with time zone,
    account_id text NOT NULL
);


--
-- Name: _migrations; Type: TABLE; Schema: stripe; Owner: -
--

CREATE TABLE stripe._migrations (
    id integer NOT NULL,
    name character varying(100) NOT NULL,
    hash character varying(40) NOT NULL,
    executed_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: _sync_status; Type: TABLE; Schema: stripe; Owner: -
--

CREATE TABLE stripe._sync_status (
    id integer NOT NULL,
    resource text NOT NULL,
    status text DEFAULT 'idle'::text,
    last_synced_at timestamp with time zone DEFAULT now(),
    last_incremental_cursor timestamp with time zone,
    error_message text,
    updated_at timestamp with time zone DEFAULT now(),
    account_id text NOT NULL,
    CONSTRAINT _sync_status_status_check CHECK ((status = ANY (ARRAY['idle'::text, 'running'::text, 'complete'::text, 'error'::text])))
);


--
-- Name: _sync_status_id_seq; Type: SEQUENCE; Schema: stripe; Owner: -
--

CREATE SEQUENCE stripe._sync_status_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: _sync_status_id_seq; Type: SEQUENCE OWNED BY; Schema: stripe; Owner: -
--

ALTER SEQUENCE stripe._sync_status_id_seq OWNED BY stripe._sync_status.id;


--
-- Name: accounts; Type: TABLE; Schema: stripe; Owner: -
--

CREATE TABLE stripe.accounts (
    _raw_data jsonb NOT NULL,
    first_synced_at timestamp with time zone DEFAULT now() NOT NULL,
    _last_synced_at timestamp with time zone DEFAULT now() NOT NULL,
    _updated_at timestamp with time zone DEFAULT now() NOT NULL,
    business_name text GENERATED ALWAYS AS (((_raw_data -> 'business_profile'::text) ->> 'name'::text)) STORED,
    email text GENERATED ALWAYS AS ((_raw_data ->> 'email'::text)) STORED,
    type text GENERATED ALWAYS AS ((_raw_data ->> 'type'::text)) STORED,
    charges_enabled boolean GENERATED ALWAYS AS (((_raw_data ->> 'charges_enabled'::text))::boolean) STORED,
    payouts_enabled boolean GENERATED ALWAYS AS (((_raw_data ->> 'payouts_enabled'::text))::boolean) STORED,
    details_submitted boolean GENERATED ALWAYS AS (((_raw_data ->> 'details_submitted'::text))::boolean) STORED,
    country text GENERATED ALWAYS AS ((_raw_data ->> 'country'::text)) STORED,
    default_currency text GENERATED ALWAYS AS ((_raw_data ->> 'default_currency'::text)) STORED,
    created integer GENERATED ALWAYS AS (((_raw_data ->> 'created'::text))::integer) STORED,
    api_key_hashes text[] DEFAULT '{}'::text[],
    id text GENERATED ALWAYS AS ((_raw_data ->> 'id'::text)) STORED NOT NULL
);


--
-- Name: active_entitlements; Type: TABLE; Schema: stripe; Owner: -
--

CREATE TABLE stripe.active_entitlements (
    _updated_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    _last_synced_at timestamp with time zone,
    _raw_data jsonb,
    _account_id text NOT NULL,
    object text GENERATED ALWAYS AS ((_raw_data ->> 'object'::text)) STORED,
    livemode boolean GENERATED ALWAYS AS (((_raw_data ->> 'livemode'::text))::boolean) STORED,
    feature text GENERATED ALWAYS AS ((_raw_data ->> 'feature'::text)) STORED,
    customer text GENERATED ALWAYS AS ((_raw_data ->> 'customer'::text)) STORED,
    lookup_key text GENERATED ALWAYS AS ((_raw_data ->> 'lookup_key'::text)) STORED,
    id text GENERATED ALWAYS AS ((_raw_data ->> 'id'::text)) STORED NOT NULL
);


--
-- Name: charges; Type: TABLE; Schema: stripe; Owner: -
--

CREATE TABLE stripe.charges (
    _updated_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    _last_synced_at timestamp with time zone,
    _raw_data jsonb,
    _account_id text NOT NULL,
    object text GENERATED ALWAYS AS ((_raw_data ->> 'object'::text)) STORED,
    paid boolean GENERATED ALWAYS AS (((_raw_data ->> 'paid'::text))::boolean) STORED,
    "order" text GENERATED ALWAYS AS ((_raw_data ->> 'order'::text)) STORED,
    amount bigint GENERATED ALWAYS AS (((_raw_data ->> 'amount'::text))::bigint) STORED,
    review text GENERATED ALWAYS AS ((_raw_data ->> 'review'::text)) STORED,
    source jsonb GENERATED ALWAYS AS ((_raw_data -> 'source'::text)) STORED,
    status text GENERATED ALWAYS AS ((_raw_data ->> 'status'::text)) STORED,
    created integer GENERATED ALWAYS AS (((_raw_data ->> 'created'::text))::integer) STORED,
    dispute text GENERATED ALWAYS AS ((_raw_data ->> 'dispute'::text)) STORED,
    invoice text GENERATED ALWAYS AS ((_raw_data ->> 'invoice'::text)) STORED,
    outcome jsonb GENERATED ALWAYS AS ((_raw_data -> 'outcome'::text)) STORED,
    refunds jsonb GENERATED ALWAYS AS ((_raw_data -> 'refunds'::text)) STORED,
    updated integer GENERATED ALWAYS AS (((_raw_data ->> 'updated'::text))::integer) STORED,
    captured boolean GENERATED ALWAYS AS (((_raw_data ->> 'captured'::text))::boolean) STORED,
    currency text GENERATED ALWAYS AS ((_raw_data ->> 'currency'::text)) STORED,
    customer text GENERATED ALWAYS AS ((_raw_data ->> 'customer'::text)) STORED,
    livemode boolean GENERATED ALWAYS AS (((_raw_data ->> 'livemode'::text))::boolean) STORED,
    metadata jsonb GENERATED ALWAYS AS ((_raw_data -> 'metadata'::text)) STORED,
    refunded boolean GENERATED ALWAYS AS (((_raw_data ->> 'refunded'::text))::boolean) STORED,
    shipping jsonb GENERATED ALWAYS AS ((_raw_data -> 'shipping'::text)) STORED,
    application text GENERATED ALWAYS AS ((_raw_data ->> 'application'::text)) STORED,
    description text GENERATED ALWAYS AS ((_raw_data ->> 'description'::text)) STORED,
    destination text GENERATED ALWAYS AS ((_raw_data ->> 'destination'::text)) STORED,
    failure_code text GENERATED ALWAYS AS ((_raw_data ->> 'failure_code'::text)) STORED,
    on_behalf_of text GENERATED ALWAYS AS ((_raw_data ->> 'on_behalf_of'::text)) STORED,
    fraud_details jsonb GENERATED ALWAYS AS ((_raw_data -> 'fraud_details'::text)) STORED,
    receipt_email text GENERATED ALWAYS AS ((_raw_data ->> 'receipt_email'::text)) STORED,
    payment_intent text GENERATED ALWAYS AS ((_raw_data ->> 'payment_intent'::text)) STORED,
    receipt_number text GENERATED ALWAYS AS ((_raw_data ->> 'receipt_number'::text)) STORED,
    transfer_group text GENERATED ALWAYS AS ((_raw_data ->> 'transfer_group'::text)) STORED,
    amount_refunded bigint GENERATED ALWAYS AS (((_raw_data ->> 'amount_refunded'::text))::bigint) STORED,
    application_fee text GENERATED ALWAYS AS ((_raw_data ->> 'application_fee'::text)) STORED,
    failure_message text GENERATED ALWAYS AS ((_raw_data ->> 'failure_message'::text)) STORED,
    source_transfer text GENERATED ALWAYS AS ((_raw_data ->> 'source_transfer'::text)) STORED,
    balance_transaction text GENERATED ALWAYS AS ((_raw_data ->> 'balance_transaction'::text)) STORED,
    statement_descriptor text GENERATED ALWAYS AS ((_raw_data ->> 'statement_descriptor'::text)) STORED,
    payment_method_details jsonb GENERATED ALWAYS AS ((_raw_data -> 'payment_method_details'::text)) STORED,
    id text GENERATED ALWAYS AS ((_raw_data ->> 'id'::text)) STORED NOT NULL
);


--
-- Name: checkout_session_line_items; Type: TABLE; Schema: stripe; Owner: -
--

CREATE TABLE stripe.checkout_session_line_items (
    _updated_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    _last_synced_at timestamp with time zone,
    _raw_data jsonb,
    _account_id text NOT NULL,
    object text GENERATED ALWAYS AS ((_raw_data ->> 'object'::text)) STORED,
    amount_discount integer GENERATED ALWAYS AS (((_raw_data ->> 'amount_discount'::text))::integer) STORED,
    amount_subtotal integer GENERATED ALWAYS AS (((_raw_data ->> 'amount_subtotal'::text))::integer) STORED,
    amount_tax integer GENERATED ALWAYS AS (((_raw_data ->> 'amount_tax'::text))::integer) STORED,
    amount_total integer GENERATED ALWAYS AS (((_raw_data ->> 'amount_total'::text))::integer) STORED,
    currency text GENERATED ALWAYS AS ((_raw_data ->> 'currency'::text)) STORED,
    description text GENERATED ALWAYS AS ((_raw_data ->> 'description'::text)) STORED,
    price text GENERATED ALWAYS AS ((_raw_data ->> 'price'::text)) STORED,
    quantity integer GENERATED ALWAYS AS (((_raw_data ->> 'quantity'::text))::integer) STORED,
    checkout_session text GENERATED ALWAYS AS ((_raw_data ->> 'checkout_session'::text)) STORED,
    id text GENERATED ALWAYS AS ((_raw_data ->> 'id'::text)) STORED NOT NULL
);


--
-- Name: checkout_sessions; Type: TABLE; Schema: stripe; Owner: -
--

CREATE TABLE stripe.checkout_sessions (
    _updated_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    _last_synced_at timestamp with time zone,
    _raw_data jsonb,
    _account_id text NOT NULL,
    object text GENERATED ALWAYS AS ((_raw_data ->> 'object'::text)) STORED,
    adaptive_pricing jsonb GENERATED ALWAYS AS ((_raw_data -> 'adaptive_pricing'::text)) STORED,
    after_expiration jsonb GENERATED ALWAYS AS ((_raw_data -> 'after_expiration'::text)) STORED,
    allow_promotion_codes boolean GENERATED ALWAYS AS (((_raw_data ->> 'allow_promotion_codes'::text))::boolean) STORED,
    amount_subtotal integer GENERATED ALWAYS AS (((_raw_data ->> 'amount_subtotal'::text))::integer) STORED,
    amount_total integer GENERATED ALWAYS AS (((_raw_data ->> 'amount_total'::text))::integer) STORED,
    automatic_tax jsonb GENERATED ALWAYS AS ((_raw_data -> 'automatic_tax'::text)) STORED,
    billing_address_collection text GENERATED ALWAYS AS ((_raw_data ->> 'billing_address_collection'::text)) STORED,
    cancel_url text GENERATED ALWAYS AS ((_raw_data ->> 'cancel_url'::text)) STORED,
    client_reference_id text GENERATED ALWAYS AS ((_raw_data ->> 'client_reference_id'::text)) STORED,
    client_secret text GENERATED ALWAYS AS ((_raw_data ->> 'client_secret'::text)) STORED,
    collected_information jsonb GENERATED ALWAYS AS ((_raw_data -> 'collected_information'::text)) STORED,
    consent jsonb GENERATED ALWAYS AS ((_raw_data -> 'consent'::text)) STORED,
    consent_collection jsonb GENERATED ALWAYS AS ((_raw_data -> 'consent_collection'::text)) STORED,
    created integer GENERATED ALWAYS AS (((_raw_data ->> 'created'::text))::integer) STORED,
    currency text GENERATED ALWAYS AS ((_raw_data ->> 'currency'::text)) STORED,
    currency_conversion jsonb GENERATED ALWAYS AS ((_raw_data -> 'currency_conversion'::text)) STORED,
    custom_fields jsonb GENERATED ALWAYS AS ((_raw_data -> 'custom_fields'::text)) STORED,
    custom_text jsonb GENERATED ALWAYS AS ((_raw_data -> 'custom_text'::text)) STORED,
    customer text GENERATED ALWAYS AS ((_raw_data ->> 'customer'::text)) STORED,
    customer_creation text GENERATED ALWAYS AS ((_raw_data ->> 'customer_creation'::text)) STORED,
    customer_details jsonb GENERATED ALWAYS AS ((_raw_data -> 'customer_details'::text)) STORED,
    customer_email text GENERATED ALWAYS AS ((_raw_data ->> 'customer_email'::text)) STORED,
    discounts jsonb GENERATED ALWAYS AS ((_raw_data -> 'discounts'::text)) STORED,
    expires_at integer GENERATED ALWAYS AS (((_raw_data ->> 'expires_at'::text))::integer) STORED,
    invoice text GENERATED ALWAYS AS ((_raw_data ->> 'invoice'::text)) STORED,
    invoice_creation jsonb GENERATED ALWAYS AS ((_raw_data -> 'invoice_creation'::text)) STORED,
    livemode boolean GENERATED ALWAYS AS (((_raw_data ->> 'livemode'::text))::boolean) STORED,
    locale text GENERATED ALWAYS AS ((_raw_data ->> 'locale'::text)) STORED,
    metadata jsonb GENERATED ALWAYS AS ((_raw_data -> 'metadata'::text)) STORED,
    mode text GENERATED ALWAYS AS ((_raw_data ->> 'mode'::text)) STORED,
    optional_items jsonb GENERATED ALWAYS AS ((_raw_data -> 'optional_items'::text)) STORED,
    payment_intent text GENERATED ALWAYS AS ((_raw_data ->> 'payment_intent'::text)) STORED,
    payment_link text GENERATED ALWAYS AS ((_raw_data ->> 'payment_link'::text)) STORED,
    payment_method_collection text GENERATED ALWAYS AS ((_raw_data ->> 'payment_method_collection'::text)) STORED,
    payment_method_configuration_details jsonb GENERATED ALWAYS AS ((_raw_data -> 'payment_method_configuration_details'::text)) STORED,
    payment_method_options jsonb GENERATED ALWAYS AS ((_raw_data -> 'payment_method_options'::text)) STORED,
    payment_method_types jsonb GENERATED ALWAYS AS ((_raw_data -> 'payment_method_types'::text)) STORED,
    payment_status text GENERATED ALWAYS AS ((_raw_data ->> 'payment_status'::text)) STORED,
    permissions jsonb GENERATED ALWAYS AS ((_raw_data -> 'permissions'::text)) STORED,
    phone_number_collection jsonb GENERATED ALWAYS AS ((_raw_data -> 'phone_number_collection'::text)) STORED,
    presentment_details jsonb GENERATED ALWAYS AS ((_raw_data -> 'presentment_details'::text)) STORED,
    recovered_from text GENERATED ALWAYS AS ((_raw_data ->> 'recovered_from'::text)) STORED,
    redirect_on_completion text GENERATED ALWAYS AS ((_raw_data ->> 'redirect_on_completion'::text)) STORED,
    return_url text GENERATED ALWAYS AS ((_raw_data ->> 'return_url'::text)) STORED,
    saved_payment_method_options jsonb GENERATED ALWAYS AS ((_raw_data -> 'saved_payment_method_options'::text)) STORED,
    setup_intent text GENERATED ALWAYS AS ((_raw_data ->> 'setup_intent'::text)) STORED,
    shipping_address_collection jsonb GENERATED ALWAYS AS ((_raw_data -> 'shipping_address_collection'::text)) STORED,
    shipping_cost jsonb GENERATED ALWAYS AS ((_raw_data -> 'shipping_cost'::text)) STORED,
    shipping_details jsonb GENERATED ALWAYS AS ((_raw_data -> 'shipping_details'::text)) STORED,
    shipping_options jsonb GENERATED ALWAYS AS ((_raw_data -> 'shipping_options'::text)) STORED,
    status text GENERATED ALWAYS AS ((_raw_data ->> 'status'::text)) STORED,
    submit_type text GENERATED ALWAYS AS ((_raw_data ->> 'submit_type'::text)) STORED,
    subscription text GENERATED ALWAYS AS ((_raw_data ->> 'subscription'::text)) STORED,
    success_url text GENERATED ALWAYS AS ((_raw_data ->> 'success_url'::text)) STORED,
    tax_id_collection jsonb GENERATED ALWAYS AS ((_raw_data -> 'tax_id_collection'::text)) STORED,
    total_details jsonb GENERATED ALWAYS AS ((_raw_data -> 'total_details'::text)) STORED,
    ui_mode text GENERATED ALWAYS AS ((_raw_data ->> 'ui_mode'::text)) STORED,
    url text GENERATED ALWAYS AS ((_raw_data ->> 'url'::text)) STORED,
    wallet_options jsonb GENERATED ALWAYS AS ((_raw_data -> 'wallet_options'::text)) STORED,
    id text GENERATED ALWAYS AS ((_raw_data ->> 'id'::text)) STORED NOT NULL
);


--
-- Name: coupons; Type: TABLE; Schema: stripe; Owner: -
--

CREATE TABLE stripe.coupons (
    _updated_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    _last_synced_at timestamp with time zone,
    _raw_data jsonb,
    object text GENERATED ALWAYS AS ((_raw_data ->> 'object'::text)) STORED,
    name text GENERATED ALWAYS AS ((_raw_data ->> 'name'::text)) STORED,
    valid boolean GENERATED ALWAYS AS (((_raw_data ->> 'valid'::text))::boolean) STORED,
    created integer GENERATED ALWAYS AS (((_raw_data ->> 'created'::text))::integer) STORED,
    updated integer GENERATED ALWAYS AS (((_raw_data ->> 'updated'::text))::integer) STORED,
    currency text GENERATED ALWAYS AS ((_raw_data ->> 'currency'::text)) STORED,
    duration text GENERATED ALWAYS AS ((_raw_data ->> 'duration'::text)) STORED,
    livemode boolean GENERATED ALWAYS AS (((_raw_data ->> 'livemode'::text))::boolean) STORED,
    metadata jsonb GENERATED ALWAYS AS ((_raw_data -> 'metadata'::text)) STORED,
    redeem_by integer GENERATED ALWAYS AS (((_raw_data ->> 'redeem_by'::text))::integer) STORED,
    amount_off bigint GENERATED ALWAYS AS (((_raw_data ->> 'amount_off'::text))::bigint) STORED,
    percent_off double precision GENERATED ALWAYS AS (((_raw_data ->> 'percent_off'::text))::double precision) STORED,
    times_redeemed bigint GENERATED ALWAYS AS (((_raw_data ->> 'times_redeemed'::text))::bigint) STORED,
    max_redemptions bigint GENERATED ALWAYS AS (((_raw_data ->> 'max_redemptions'::text))::bigint) STORED,
    duration_in_months bigint GENERATED ALWAYS AS (((_raw_data ->> 'duration_in_months'::text))::bigint) STORED,
    percent_off_precise double precision GENERATED ALWAYS AS (((_raw_data ->> 'percent_off_precise'::text))::double precision) STORED,
    id text GENERATED ALWAYS AS ((_raw_data ->> 'id'::text)) STORED NOT NULL
);


--
-- Name: credit_notes; Type: TABLE; Schema: stripe; Owner: -
--

CREATE TABLE stripe.credit_notes (
    _last_synced_at timestamp with time zone,
    _raw_data jsonb,
    _account_id text NOT NULL,
    object text GENERATED ALWAYS AS ((_raw_data ->> 'object'::text)) STORED,
    amount integer GENERATED ALWAYS AS (((_raw_data ->> 'amount'::text))::integer) STORED,
    amount_shipping integer GENERATED ALWAYS AS (((_raw_data ->> 'amount_shipping'::text))::integer) STORED,
    created integer GENERATED ALWAYS AS (((_raw_data ->> 'created'::text))::integer) STORED,
    currency text GENERATED ALWAYS AS ((_raw_data ->> 'currency'::text)) STORED,
    customer text GENERATED ALWAYS AS ((_raw_data ->> 'customer'::text)) STORED,
    customer_balance_transaction text GENERATED ALWAYS AS ((_raw_data ->> 'customer_balance_transaction'::text)) STORED,
    discount_amount integer GENERATED ALWAYS AS (((_raw_data ->> 'discount_amount'::text))::integer) STORED,
    discount_amounts jsonb GENERATED ALWAYS AS ((_raw_data -> 'discount_amounts'::text)) STORED,
    invoice text GENERATED ALWAYS AS ((_raw_data ->> 'invoice'::text)) STORED,
    lines jsonb GENERATED ALWAYS AS ((_raw_data -> 'lines'::text)) STORED,
    livemode boolean GENERATED ALWAYS AS (((_raw_data ->> 'livemode'::text))::boolean) STORED,
    memo text GENERATED ALWAYS AS ((_raw_data ->> 'memo'::text)) STORED,
    metadata jsonb GENERATED ALWAYS AS ((_raw_data -> 'metadata'::text)) STORED,
    number text GENERATED ALWAYS AS ((_raw_data ->> 'number'::text)) STORED,
    out_of_band_amount integer GENERATED ALWAYS AS (((_raw_data ->> 'out_of_band_amount'::text))::integer) STORED,
    pdf text GENERATED ALWAYS AS ((_raw_data ->> 'pdf'::text)) STORED,
    reason text GENERATED ALWAYS AS ((_raw_data ->> 'reason'::text)) STORED,
    refund text GENERATED ALWAYS AS ((_raw_data ->> 'refund'::text)) STORED,
    shipping_cost jsonb GENERATED ALWAYS AS ((_raw_data -> 'shipping_cost'::text)) STORED,
    status text GENERATED ALWAYS AS ((_raw_data ->> 'status'::text)) STORED,
    subtotal integer GENERATED ALWAYS AS (((_raw_data ->> 'subtotal'::text))::integer) STORED,
    subtotal_excluding_tax integer GENERATED ALWAYS AS (((_raw_data ->> 'subtotal_excluding_tax'::text))::integer) STORED,
    tax_amounts jsonb GENERATED ALWAYS AS ((_raw_data -> 'tax_amounts'::text)) STORED,
    total integer GENERATED ALWAYS AS (((_raw_data ->> 'total'::text))::integer) STORED,
    total_excluding_tax integer GENERATED ALWAYS AS (((_raw_data ->> 'total_excluding_tax'::text))::integer) STORED,
    type text GENERATED ALWAYS AS ((_raw_data ->> 'type'::text)) STORED,
    voided_at text GENERATED ALWAYS AS ((_raw_data ->> 'voided_at'::text)) STORED,
    id text GENERATED ALWAYS AS ((_raw_data ->> 'id'::text)) STORED NOT NULL
);


--
-- Name: customers; Type: TABLE; Schema: stripe; Owner: -
--

CREATE TABLE stripe.customers (
    _updated_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    _last_synced_at timestamp with time zone,
    _raw_data jsonb,
    _account_id text NOT NULL,
    object text GENERATED ALWAYS AS ((_raw_data ->> 'object'::text)) STORED,
    address jsonb GENERATED ALWAYS AS ((_raw_data -> 'address'::text)) STORED,
    description text GENERATED ALWAYS AS ((_raw_data ->> 'description'::text)) STORED,
    email text GENERATED ALWAYS AS ((_raw_data ->> 'email'::text)) STORED,
    metadata jsonb GENERATED ALWAYS AS ((_raw_data -> 'metadata'::text)) STORED,
    name text GENERATED ALWAYS AS ((_raw_data ->> 'name'::text)) STORED,
    phone text GENERATED ALWAYS AS ((_raw_data ->> 'phone'::text)) STORED,
    shipping jsonb GENERATED ALWAYS AS ((_raw_data -> 'shipping'::text)) STORED,
    balance integer GENERATED ALWAYS AS (((_raw_data ->> 'balance'::text))::integer) STORED,
    created integer GENERATED ALWAYS AS (((_raw_data ->> 'created'::text))::integer) STORED,
    currency text GENERATED ALWAYS AS ((_raw_data ->> 'currency'::text)) STORED,
    default_source text GENERATED ALWAYS AS ((_raw_data ->> 'default_source'::text)) STORED,
    delinquent boolean GENERATED ALWAYS AS (((_raw_data ->> 'delinquent'::text))::boolean) STORED,
    discount jsonb GENERATED ALWAYS AS ((_raw_data -> 'discount'::text)) STORED,
    invoice_prefix text GENERATED ALWAYS AS ((_raw_data ->> 'invoice_prefix'::text)) STORED,
    invoice_settings jsonb GENERATED ALWAYS AS ((_raw_data -> 'invoice_settings'::text)) STORED,
    livemode boolean GENERATED ALWAYS AS (((_raw_data ->> 'livemode'::text))::boolean) STORED,
    next_invoice_sequence integer GENERATED ALWAYS AS (((_raw_data ->> 'next_invoice_sequence'::text))::integer) STORED,
    preferred_locales jsonb GENERATED ALWAYS AS ((_raw_data -> 'preferred_locales'::text)) STORED,
    tax_exempt text GENERATED ALWAYS AS ((_raw_data ->> 'tax_exempt'::text)) STORED,
    deleted boolean GENERATED ALWAYS AS (((_raw_data ->> 'deleted'::text))::boolean) STORED,
    id text GENERATED ALWAYS AS ((_raw_data ->> 'id'::text)) STORED NOT NULL
);


--
-- Name: disputes; Type: TABLE; Schema: stripe; Owner: -
--

CREATE TABLE stripe.disputes (
    _updated_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    _last_synced_at timestamp with time zone,
    _raw_data jsonb,
    _account_id text NOT NULL,
    object text GENERATED ALWAYS AS ((_raw_data ->> 'object'::text)) STORED,
    amount bigint GENERATED ALWAYS AS (((_raw_data ->> 'amount'::text))::bigint) STORED,
    charge text GENERATED ALWAYS AS ((_raw_data ->> 'charge'::text)) STORED,
    reason text GENERATED ALWAYS AS ((_raw_data ->> 'reason'::text)) STORED,
    status text GENERATED ALWAYS AS ((_raw_data ->> 'status'::text)) STORED,
    created integer GENERATED ALWAYS AS (((_raw_data ->> 'created'::text))::integer) STORED,
    updated integer GENERATED ALWAYS AS (((_raw_data ->> 'updated'::text))::integer) STORED,
    currency text GENERATED ALWAYS AS ((_raw_data ->> 'currency'::text)) STORED,
    evidence jsonb GENERATED ALWAYS AS ((_raw_data -> 'evidence'::text)) STORED,
    livemode boolean GENERATED ALWAYS AS (((_raw_data ->> 'livemode'::text))::boolean) STORED,
    metadata jsonb GENERATED ALWAYS AS ((_raw_data -> 'metadata'::text)) STORED,
    evidence_details jsonb GENERATED ALWAYS AS ((_raw_data -> 'evidence_details'::text)) STORED,
    balance_transactions jsonb GENERATED ALWAYS AS ((_raw_data -> 'balance_transactions'::text)) STORED,
    is_charge_refundable boolean GENERATED ALWAYS AS (((_raw_data ->> 'is_charge_refundable'::text))::boolean) STORED,
    payment_intent text GENERATED ALWAYS AS ((_raw_data ->> 'payment_intent'::text)) STORED,
    id text GENERATED ALWAYS AS ((_raw_data ->> 'id'::text)) STORED NOT NULL
);


--
-- Name: early_fraud_warnings; Type: TABLE; Schema: stripe; Owner: -
--

CREATE TABLE stripe.early_fraud_warnings (
    _updated_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    _last_synced_at timestamp with time zone,
    _raw_data jsonb,
    _account_id text NOT NULL,
    object text GENERATED ALWAYS AS ((_raw_data ->> 'object'::text)) STORED,
    actionable boolean GENERATED ALWAYS AS (((_raw_data ->> 'actionable'::text))::boolean) STORED,
    charge text GENERATED ALWAYS AS ((_raw_data ->> 'charge'::text)) STORED,
    created integer GENERATED ALWAYS AS (((_raw_data ->> 'created'::text))::integer) STORED,
    fraud_type text GENERATED ALWAYS AS ((_raw_data ->> 'fraud_type'::text)) STORED,
    livemode boolean GENERATED ALWAYS AS (((_raw_data ->> 'livemode'::text))::boolean) STORED,
    payment_intent text GENERATED ALWAYS AS ((_raw_data ->> 'payment_intent'::text)) STORED,
    id text GENERATED ALWAYS AS ((_raw_data ->> 'id'::text)) STORED NOT NULL
);


--
-- Name: events; Type: TABLE; Schema: stripe; Owner: -
--

CREATE TABLE stripe.events (
    _updated_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    _last_synced_at timestamp with time zone,
    _raw_data jsonb,
    object text GENERATED ALWAYS AS ((_raw_data ->> 'object'::text)) STORED,
    data jsonb GENERATED ALWAYS AS ((_raw_data -> 'data'::text)) STORED,
    type text GENERATED ALWAYS AS ((_raw_data ->> 'type'::text)) STORED,
    created integer GENERATED ALWAYS AS (((_raw_data ->> 'created'::text))::integer) STORED,
    request text GENERATED ALWAYS AS ((_raw_data ->> 'request'::text)) STORED,
    updated integer GENERATED ALWAYS AS (((_raw_data ->> 'updated'::text))::integer) STORED,
    livemode boolean GENERATED ALWAYS AS (((_raw_data ->> 'livemode'::text))::boolean) STORED,
    api_version text GENERATED ALWAYS AS ((_raw_data ->> 'api_version'::text)) STORED,
    pending_webhooks bigint GENERATED ALWAYS AS (((_raw_data ->> 'pending_webhooks'::text))::bigint) STORED,
    id text GENERATED ALWAYS AS ((_raw_data ->> 'id'::text)) STORED NOT NULL
);


--
-- Name: features; Type: TABLE; Schema: stripe; Owner: -
--

CREATE TABLE stripe.features (
    _updated_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    _last_synced_at timestamp with time zone,
    _raw_data jsonb,
    _account_id text NOT NULL,
    object text GENERATED ALWAYS AS ((_raw_data ->> 'object'::text)) STORED,
    livemode boolean GENERATED ALWAYS AS (((_raw_data ->> 'livemode'::text))::boolean) STORED,
    name text GENERATED ALWAYS AS ((_raw_data ->> 'name'::text)) STORED,
    lookup_key text GENERATED ALWAYS AS ((_raw_data ->> 'lookup_key'::text)) STORED,
    active boolean GENERATED ALWAYS AS (((_raw_data ->> 'active'::text))::boolean) STORED,
    metadata jsonb GENERATED ALWAYS AS ((_raw_data -> 'metadata'::text)) STORED,
    id text GENERATED ALWAYS AS ((_raw_data ->> 'id'::text)) STORED NOT NULL
);


--
-- Name: invoices; Type: TABLE; Schema: stripe; Owner: -
--

CREATE TABLE stripe.invoices (
    _updated_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    _last_synced_at timestamp with time zone,
    _raw_data jsonb,
    _account_id text NOT NULL,
    object text GENERATED ALWAYS AS ((_raw_data ->> 'object'::text)) STORED,
    auto_advance boolean GENERATED ALWAYS AS (((_raw_data ->> 'auto_advance'::text))::boolean) STORED,
    collection_method text GENERATED ALWAYS AS ((_raw_data ->> 'collection_method'::text)) STORED,
    currency text GENERATED ALWAYS AS ((_raw_data ->> 'currency'::text)) STORED,
    description text GENERATED ALWAYS AS ((_raw_data ->> 'description'::text)) STORED,
    hosted_invoice_url text GENERATED ALWAYS AS ((_raw_data ->> 'hosted_invoice_url'::text)) STORED,
    lines jsonb GENERATED ALWAYS AS ((_raw_data -> 'lines'::text)) STORED,
    period_end integer GENERATED ALWAYS AS (((_raw_data ->> 'period_end'::text))::integer) STORED,
    period_start integer GENERATED ALWAYS AS (((_raw_data ->> 'period_start'::text))::integer) STORED,
    status text GENERATED ALWAYS AS ((_raw_data ->> 'status'::text)) STORED,
    total bigint GENERATED ALWAYS AS (((_raw_data ->> 'total'::text))::bigint) STORED,
    account_country text GENERATED ALWAYS AS ((_raw_data ->> 'account_country'::text)) STORED,
    account_name text GENERATED ALWAYS AS ((_raw_data ->> 'account_name'::text)) STORED,
    account_tax_ids jsonb GENERATED ALWAYS AS ((_raw_data -> 'account_tax_ids'::text)) STORED,
    amount_due bigint GENERATED ALWAYS AS (((_raw_data ->> 'amount_due'::text))::bigint) STORED,
    amount_paid bigint GENERATED ALWAYS AS (((_raw_data ->> 'amount_paid'::text))::bigint) STORED,
    amount_remaining bigint GENERATED ALWAYS AS (((_raw_data ->> 'amount_remaining'::text))::bigint) STORED,
    application_fee_amount bigint GENERATED ALWAYS AS (((_raw_data ->> 'application_fee_amount'::text))::bigint) STORED,
    attempt_count integer GENERATED ALWAYS AS (((_raw_data ->> 'attempt_count'::text))::integer) STORED,
    attempted boolean GENERATED ALWAYS AS (((_raw_data ->> 'attempted'::text))::boolean) STORED,
    billing_reason text GENERATED ALWAYS AS ((_raw_data ->> 'billing_reason'::text)) STORED,
    created integer GENERATED ALWAYS AS (((_raw_data ->> 'created'::text))::integer) STORED,
    custom_fields jsonb GENERATED ALWAYS AS ((_raw_data -> 'custom_fields'::text)) STORED,
    customer_address jsonb GENERATED ALWAYS AS ((_raw_data -> 'customer_address'::text)) STORED,
    customer_email text GENERATED ALWAYS AS ((_raw_data ->> 'customer_email'::text)) STORED,
    customer_name text GENERATED ALWAYS AS ((_raw_data ->> 'customer_name'::text)) STORED,
    customer_phone text GENERATED ALWAYS AS ((_raw_data ->> 'customer_phone'::text)) STORED,
    customer_shipping jsonb GENERATED ALWAYS AS ((_raw_data -> 'customer_shipping'::text)) STORED,
    customer_tax_exempt text GENERATED ALWAYS AS ((_raw_data ->> 'customer_tax_exempt'::text)) STORED,
    customer_tax_ids jsonb GENERATED ALWAYS AS ((_raw_data -> 'customer_tax_ids'::text)) STORED,
    default_tax_rates jsonb GENERATED ALWAYS AS ((_raw_data -> 'default_tax_rates'::text)) STORED,
    discount jsonb GENERATED ALWAYS AS ((_raw_data -> 'discount'::text)) STORED,
    discounts jsonb GENERATED ALWAYS AS ((_raw_data -> 'discounts'::text)) STORED,
    due_date integer GENERATED ALWAYS AS (((_raw_data ->> 'due_date'::text))::integer) STORED,
    ending_balance integer GENERATED ALWAYS AS (((_raw_data ->> 'ending_balance'::text))::integer) STORED,
    footer text GENERATED ALWAYS AS ((_raw_data ->> 'footer'::text)) STORED,
    invoice_pdf text GENERATED ALWAYS AS ((_raw_data ->> 'invoice_pdf'::text)) STORED,
    last_finalization_error jsonb GENERATED ALWAYS AS ((_raw_data -> 'last_finalization_error'::text)) STORED,
    livemode boolean GENERATED ALWAYS AS (((_raw_data ->> 'livemode'::text))::boolean) STORED,
    next_payment_attempt integer GENERATED ALWAYS AS (((_raw_data ->> 'next_payment_attempt'::text))::integer) STORED,
    number text GENERATED ALWAYS AS ((_raw_data ->> 'number'::text)) STORED,
    paid boolean GENERATED ALWAYS AS (((_raw_data ->> 'paid'::text))::boolean) STORED,
    payment_settings jsonb GENERATED ALWAYS AS ((_raw_data -> 'payment_settings'::text)) STORED,
    post_payment_credit_notes_amount integer GENERATED ALWAYS AS (((_raw_data ->> 'post_payment_credit_notes_amount'::text))::integer) STORED,
    pre_payment_credit_notes_amount integer GENERATED ALWAYS AS (((_raw_data ->> 'pre_payment_credit_notes_amount'::text))::integer) STORED,
    receipt_number text GENERATED ALWAYS AS ((_raw_data ->> 'receipt_number'::text)) STORED,
    starting_balance integer GENERATED ALWAYS AS (((_raw_data ->> 'starting_balance'::text))::integer) STORED,
    statement_descriptor text GENERATED ALWAYS AS ((_raw_data ->> 'statement_descriptor'::text)) STORED,
    status_transitions jsonb GENERATED ALWAYS AS ((_raw_data -> 'status_transitions'::text)) STORED,
    subtotal integer GENERATED ALWAYS AS (((_raw_data ->> 'subtotal'::text))::integer) STORED,
    tax integer GENERATED ALWAYS AS (((_raw_data ->> 'tax'::text))::integer) STORED,
    total_discount_amounts jsonb GENERATED ALWAYS AS ((_raw_data -> 'total_discount_amounts'::text)) STORED,
    total_tax_amounts jsonb GENERATED ALWAYS AS ((_raw_data -> 'total_tax_amounts'::text)) STORED,
    transfer_data jsonb GENERATED ALWAYS AS ((_raw_data -> 'transfer_data'::text)) STORED,
    webhooks_delivered_at integer GENERATED ALWAYS AS (((_raw_data ->> 'webhooks_delivered_at'::text))::integer) STORED,
    customer text GENERATED ALWAYS AS ((_raw_data ->> 'customer'::text)) STORED,
    subscription text GENERATED ALWAYS AS ((_raw_data ->> 'subscription'::text)) STORED,
    payment_intent text GENERATED ALWAYS AS ((_raw_data ->> 'payment_intent'::text)) STORED,
    default_payment_method text GENERATED ALWAYS AS ((_raw_data ->> 'default_payment_method'::text)) STORED,
    default_source text GENERATED ALWAYS AS ((_raw_data ->> 'default_source'::text)) STORED,
    on_behalf_of text GENERATED ALWAYS AS ((_raw_data ->> 'on_behalf_of'::text)) STORED,
    charge text GENERATED ALWAYS AS ((_raw_data ->> 'charge'::text)) STORED,
    metadata jsonb GENERATED ALWAYS AS ((_raw_data -> 'metadata'::text)) STORED,
    id text GENERATED ALWAYS AS ((_raw_data ->> 'id'::text)) STORED NOT NULL
);


--
-- Name: payment_intents; Type: TABLE; Schema: stripe; Owner: -
--

CREATE TABLE stripe.payment_intents (
    _last_synced_at timestamp with time zone,
    _raw_data jsonb,
    _account_id text NOT NULL,
    object text GENERATED ALWAYS AS ((_raw_data ->> 'object'::text)) STORED,
    amount integer GENERATED ALWAYS AS (((_raw_data ->> 'amount'::text))::integer) STORED,
    amount_capturable integer GENERATED ALWAYS AS (((_raw_data ->> 'amount_capturable'::text))::integer) STORED,
    amount_details jsonb GENERATED ALWAYS AS ((_raw_data -> 'amount_details'::text)) STORED,
    amount_received integer GENERATED ALWAYS AS (((_raw_data ->> 'amount_received'::text))::integer) STORED,
    application text GENERATED ALWAYS AS ((_raw_data ->> 'application'::text)) STORED,
    application_fee_amount integer GENERATED ALWAYS AS (((_raw_data ->> 'application_fee_amount'::text))::integer) STORED,
    automatic_payment_methods text GENERATED ALWAYS AS ((_raw_data ->> 'automatic_payment_methods'::text)) STORED,
    canceled_at integer GENERATED ALWAYS AS (((_raw_data ->> 'canceled_at'::text))::integer) STORED,
    cancellation_reason text GENERATED ALWAYS AS ((_raw_data ->> 'cancellation_reason'::text)) STORED,
    capture_method text GENERATED ALWAYS AS ((_raw_data ->> 'capture_method'::text)) STORED,
    client_secret text GENERATED ALWAYS AS ((_raw_data ->> 'client_secret'::text)) STORED,
    confirmation_method text GENERATED ALWAYS AS ((_raw_data ->> 'confirmation_method'::text)) STORED,
    created integer GENERATED ALWAYS AS (((_raw_data ->> 'created'::text))::integer) STORED,
    currency text GENERATED ALWAYS AS ((_raw_data ->> 'currency'::text)) STORED,
    customer text GENERATED ALWAYS AS ((_raw_data ->> 'customer'::text)) STORED,
    description text GENERATED ALWAYS AS ((_raw_data ->> 'description'::text)) STORED,
    invoice text GENERATED ALWAYS AS ((_raw_data ->> 'invoice'::text)) STORED,
    last_payment_error text GENERATED ALWAYS AS ((_raw_data ->> 'last_payment_error'::text)) STORED,
    livemode boolean GENERATED ALWAYS AS (((_raw_data ->> 'livemode'::text))::boolean) STORED,
    metadata jsonb GENERATED ALWAYS AS ((_raw_data -> 'metadata'::text)) STORED,
    next_action text GENERATED ALWAYS AS ((_raw_data ->> 'next_action'::text)) STORED,
    on_behalf_of text GENERATED ALWAYS AS ((_raw_data ->> 'on_behalf_of'::text)) STORED,
    payment_method text GENERATED ALWAYS AS ((_raw_data ->> 'payment_method'::text)) STORED,
    payment_method_options jsonb GENERATED ALWAYS AS ((_raw_data -> 'payment_method_options'::text)) STORED,
    payment_method_types jsonb GENERATED ALWAYS AS ((_raw_data -> 'payment_method_types'::text)) STORED,
    processing text GENERATED ALWAYS AS ((_raw_data ->> 'processing'::text)) STORED,
    receipt_email text GENERATED ALWAYS AS ((_raw_data ->> 'receipt_email'::text)) STORED,
    review text GENERATED ALWAYS AS ((_raw_data ->> 'review'::text)) STORED,
    setup_future_usage text GENERATED ALWAYS AS ((_raw_data ->> 'setup_future_usage'::text)) STORED,
    shipping jsonb GENERATED ALWAYS AS ((_raw_data -> 'shipping'::text)) STORED,
    statement_descriptor text GENERATED ALWAYS AS ((_raw_data ->> 'statement_descriptor'::text)) STORED,
    statement_descriptor_suffix text GENERATED ALWAYS AS ((_raw_data ->> 'statement_descriptor_suffix'::text)) STORED,
    status text GENERATED ALWAYS AS ((_raw_data ->> 'status'::text)) STORED,
    transfer_data jsonb GENERATED ALWAYS AS ((_raw_data -> 'transfer_data'::text)) STORED,
    transfer_group text GENERATED ALWAYS AS ((_raw_data ->> 'transfer_group'::text)) STORED,
    id text GENERATED ALWAYS AS ((_raw_data ->> 'id'::text)) STORED NOT NULL
);


--
-- Name: payment_methods; Type: TABLE; Schema: stripe; Owner: -
--

CREATE TABLE stripe.payment_methods (
    _last_synced_at timestamp with time zone,
    _raw_data jsonb,
    _account_id text NOT NULL,
    object text GENERATED ALWAYS AS ((_raw_data ->> 'object'::text)) STORED,
    created integer GENERATED ALWAYS AS (((_raw_data ->> 'created'::text))::integer) STORED,
    customer text GENERATED ALWAYS AS ((_raw_data ->> 'customer'::text)) STORED,
    type text GENERATED ALWAYS AS ((_raw_data ->> 'type'::text)) STORED,
    billing_details jsonb GENERATED ALWAYS AS ((_raw_data -> 'billing_details'::text)) STORED,
    metadata jsonb GENERATED ALWAYS AS ((_raw_data -> 'metadata'::text)) STORED,
    card jsonb GENERATED ALWAYS AS ((_raw_data -> 'card'::text)) STORED,
    id text GENERATED ALWAYS AS ((_raw_data ->> 'id'::text)) STORED NOT NULL
);


--
-- Name: payouts; Type: TABLE; Schema: stripe; Owner: -
--

CREATE TABLE stripe.payouts (
    _updated_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    _last_synced_at timestamp with time zone,
    _raw_data jsonb,
    object text GENERATED ALWAYS AS ((_raw_data ->> 'object'::text)) STORED,
    date text GENERATED ALWAYS AS ((_raw_data ->> 'date'::text)) STORED,
    type text GENERATED ALWAYS AS ((_raw_data ->> 'type'::text)) STORED,
    amount bigint GENERATED ALWAYS AS (((_raw_data ->> 'amount'::text))::bigint) STORED,
    method text GENERATED ALWAYS AS ((_raw_data ->> 'method'::text)) STORED,
    status text GENERATED ALWAYS AS ((_raw_data ->> 'status'::text)) STORED,
    created integer GENERATED ALWAYS AS (((_raw_data ->> 'created'::text))::integer) STORED,
    updated integer GENERATED ALWAYS AS (((_raw_data ->> 'updated'::text))::integer) STORED,
    currency text GENERATED ALWAYS AS ((_raw_data ->> 'currency'::text)) STORED,
    livemode boolean GENERATED ALWAYS AS (((_raw_data ->> 'livemode'::text))::boolean) STORED,
    metadata jsonb GENERATED ALWAYS AS ((_raw_data -> 'metadata'::text)) STORED,
    automatic boolean GENERATED ALWAYS AS (((_raw_data ->> 'automatic'::text))::boolean) STORED,
    recipient text GENERATED ALWAYS AS ((_raw_data ->> 'recipient'::text)) STORED,
    description text GENERATED ALWAYS AS ((_raw_data ->> 'description'::text)) STORED,
    destination text GENERATED ALWAYS AS ((_raw_data ->> 'destination'::text)) STORED,
    source_type text GENERATED ALWAYS AS ((_raw_data ->> 'source_type'::text)) STORED,
    arrival_date text GENERATED ALWAYS AS ((_raw_data ->> 'arrival_date'::text)) STORED,
    bank_account jsonb GENERATED ALWAYS AS ((_raw_data -> 'bank_account'::text)) STORED,
    failure_code text GENERATED ALWAYS AS ((_raw_data ->> 'failure_code'::text)) STORED,
    transfer_group text GENERATED ALWAYS AS ((_raw_data ->> 'transfer_group'::text)) STORED,
    amount_reversed bigint GENERATED ALWAYS AS (((_raw_data ->> 'amount_reversed'::text))::bigint) STORED,
    failure_message text GENERATED ALWAYS AS ((_raw_data ->> 'failure_message'::text)) STORED,
    source_transaction text GENERATED ALWAYS AS ((_raw_data ->> 'source_transaction'::text)) STORED,
    balance_transaction text GENERATED ALWAYS AS ((_raw_data ->> 'balance_transaction'::text)) STORED,
    statement_descriptor text GENERATED ALWAYS AS ((_raw_data ->> 'statement_descriptor'::text)) STORED,
    statement_description text GENERATED ALWAYS AS ((_raw_data ->> 'statement_description'::text)) STORED,
    failure_balance_transaction text GENERATED ALWAYS AS ((_raw_data ->> 'failure_balance_transaction'::text)) STORED,
    id text GENERATED ALWAYS AS ((_raw_data ->> 'id'::text)) STORED NOT NULL
);


--
-- Name: plans; Type: TABLE; Schema: stripe; Owner: -
--

CREATE TABLE stripe.plans (
    _updated_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    _last_synced_at timestamp with time zone,
    _raw_data jsonb,
    _account_id text NOT NULL,
    object text GENERATED ALWAYS AS ((_raw_data ->> 'object'::text)) STORED,
    name text GENERATED ALWAYS AS ((_raw_data ->> 'name'::text)) STORED,
    tiers jsonb GENERATED ALWAYS AS ((_raw_data -> 'tiers'::text)) STORED,
    active boolean GENERATED ALWAYS AS (((_raw_data ->> 'active'::text))::boolean) STORED,
    amount bigint GENERATED ALWAYS AS (((_raw_data ->> 'amount'::text))::bigint) STORED,
    created integer GENERATED ALWAYS AS (((_raw_data ->> 'created'::text))::integer) STORED,
    product text GENERATED ALWAYS AS ((_raw_data ->> 'product'::text)) STORED,
    updated integer GENERATED ALWAYS AS (((_raw_data ->> 'updated'::text))::integer) STORED,
    currency text GENERATED ALWAYS AS ((_raw_data ->> 'currency'::text)) STORED,
    "interval" text GENERATED ALWAYS AS ((_raw_data ->> 'interval'::text)) STORED,
    livemode boolean GENERATED ALWAYS AS (((_raw_data ->> 'livemode'::text))::boolean) STORED,
    metadata jsonb GENERATED ALWAYS AS ((_raw_data -> 'metadata'::text)) STORED,
    nickname text GENERATED ALWAYS AS ((_raw_data ->> 'nickname'::text)) STORED,
    tiers_mode text GENERATED ALWAYS AS ((_raw_data ->> 'tiers_mode'::text)) STORED,
    usage_type text GENERATED ALWAYS AS ((_raw_data ->> 'usage_type'::text)) STORED,
    billing_scheme text GENERATED ALWAYS AS ((_raw_data ->> 'billing_scheme'::text)) STORED,
    interval_count bigint GENERATED ALWAYS AS (((_raw_data ->> 'interval_count'::text))::bigint) STORED,
    aggregate_usage text GENERATED ALWAYS AS ((_raw_data ->> 'aggregate_usage'::text)) STORED,
    transform_usage text GENERATED ALWAYS AS ((_raw_data ->> 'transform_usage'::text)) STORED,
    trial_period_days bigint GENERATED ALWAYS AS (((_raw_data ->> 'trial_period_days'::text))::bigint) STORED,
    statement_descriptor text GENERATED ALWAYS AS ((_raw_data ->> 'statement_descriptor'::text)) STORED,
    statement_description text GENERATED ALWAYS AS ((_raw_data ->> 'statement_description'::text)) STORED,
    id text GENERATED ALWAYS AS ((_raw_data ->> 'id'::text)) STORED NOT NULL
);


--
-- Name: prices; Type: TABLE; Schema: stripe; Owner: -
--

CREATE TABLE stripe.prices (
    _updated_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    _last_synced_at timestamp with time zone,
    _raw_data jsonb,
    _account_id text NOT NULL,
    object text GENERATED ALWAYS AS ((_raw_data ->> 'object'::text)) STORED,
    active boolean GENERATED ALWAYS AS (((_raw_data ->> 'active'::text))::boolean) STORED,
    currency text GENERATED ALWAYS AS ((_raw_data ->> 'currency'::text)) STORED,
    metadata jsonb GENERATED ALWAYS AS ((_raw_data -> 'metadata'::text)) STORED,
    nickname text GENERATED ALWAYS AS ((_raw_data ->> 'nickname'::text)) STORED,
    recurring jsonb GENERATED ALWAYS AS ((_raw_data -> 'recurring'::text)) STORED,
    type text GENERATED ALWAYS AS ((_raw_data ->> 'type'::text)) STORED,
    unit_amount integer GENERATED ALWAYS AS (((_raw_data ->> 'unit_amount'::text))::integer) STORED,
    billing_scheme text GENERATED ALWAYS AS ((_raw_data ->> 'billing_scheme'::text)) STORED,
    created integer GENERATED ALWAYS AS (((_raw_data ->> 'created'::text))::integer) STORED,
    livemode boolean GENERATED ALWAYS AS (((_raw_data ->> 'livemode'::text))::boolean) STORED,
    lookup_key text GENERATED ALWAYS AS ((_raw_data ->> 'lookup_key'::text)) STORED,
    tiers_mode text GENERATED ALWAYS AS ((_raw_data ->> 'tiers_mode'::text)) STORED,
    transform_quantity jsonb GENERATED ALWAYS AS ((_raw_data -> 'transform_quantity'::text)) STORED,
    unit_amount_decimal text GENERATED ALWAYS AS ((_raw_data ->> 'unit_amount_decimal'::text)) STORED,
    product text GENERATED ALWAYS AS ((_raw_data ->> 'product'::text)) STORED,
    id text GENERATED ALWAYS AS ((_raw_data ->> 'id'::text)) STORED NOT NULL
);


--
-- Name: products; Type: TABLE; Schema: stripe; Owner: -
--

CREATE TABLE stripe.products (
    _updated_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    _last_synced_at timestamp with time zone,
    _raw_data jsonb,
    _account_id text NOT NULL,
    object text GENERATED ALWAYS AS ((_raw_data ->> 'object'::text)) STORED,
    active boolean GENERATED ALWAYS AS (((_raw_data ->> 'active'::text))::boolean) STORED,
    default_price text GENERATED ALWAYS AS ((_raw_data ->> 'default_price'::text)) STORED,
    description text GENERATED ALWAYS AS ((_raw_data ->> 'description'::text)) STORED,
    metadata jsonb GENERATED ALWAYS AS ((_raw_data -> 'metadata'::text)) STORED,
    name text GENERATED ALWAYS AS ((_raw_data ->> 'name'::text)) STORED,
    created integer GENERATED ALWAYS AS (((_raw_data ->> 'created'::text))::integer) STORED,
    images jsonb GENERATED ALWAYS AS ((_raw_data -> 'images'::text)) STORED,
    marketing_features jsonb GENERATED ALWAYS AS ((_raw_data -> 'marketing_features'::text)) STORED,
    livemode boolean GENERATED ALWAYS AS (((_raw_data ->> 'livemode'::text))::boolean) STORED,
    package_dimensions jsonb GENERATED ALWAYS AS ((_raw_data -> 'package_dimensions'::text)) STORED,
    shippable boolean GENERATED ALWAYS AS (((_raw_data ->> 'shippable'::text))::boolean) STORED,
    statement_descriptor text GENERATED ALWAYS AS ((_raw_data ->> 'statement_descriptor'::text)) STORED,
    unit_label text GENERATED ALWAYS AS ((_raw_data ->> 'unit_label'::text)) STORED,
    updated integer GENERATED ALWAYS AS (((_raw_data ->> 'updated'::text))::integer) STORED,
    url text GENERATED ALWAYS AS ((_raw_data ->> 'url'::text)) STORED,
    id text GENERATED ALWAYS AS ((_raw_data ->> 'id'::text)) STORED NOT NULL
);


--
-- Name: refunds; Type: TABLE; Schema: stripe; Owner: -
--

CREATE TABLE stripe.refunds (
    _updated_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    _last_synced_at timestamp with time zone,
    _raw_data jsonb,
    _account_id text NOT NULL,
    object text GENERATED ALWAYS AS ((_raw_data ->> 'object'::text)) STORED,
    amount integer GENERATED ALWAYS AS (((_raw_data ->> 'amount'::text))::integer) STORED,
    balance_transaction text GENERATED ALWAYS AS ((_raw_data ->> 'balance_transaction'::text)) STORED,
    charge text GENERATED ALWAYS AS ((_raw_data ->> 'charge'::text)) STORED,
    created integer GENERATED ALWAYS AS (((_raw_data ->> 'created'::text))::integer) STORED,
    currency text GENERATED ALWAYS AS ((_raw_data ->> 'currency'::text)) STORED,
    destination_details jsonb GENERATED ALWAYS AS ((_raw_data -> 'destination_details'::text)) STORED,
    metadata jsonb GENERATED ALWAYS AS ((_raw_data -> 'metadata'::text)) STORED,
    payment_intent text GENERATED ALWAYS AS ((_raw_data ->> 'payment_intent'::text)) STORED,
    reason text GENERATED ALWAYS AS ((_raw_data ->> 'reason'::text)) STORED,
    receipt_number text GENERATED ALWAYS AS ((_raw_data ->> 'receipt_number'::text)) STORED,
    source_transfer_reversal text GENERATED ALWAYS AS ((_raw_data ->> 'source_transfer_reversal'::text)) STORED,
    status text GENERATED ALWAYS AS ((_raw_data ->> 'status'::text)) STORED,
    transfer_reversal text GENERATED ALWAYS AS ((_raw_data ->> 'transfer_reversal'::text)) STORED,
    id text GENERATED ALWAYS AS ((_raw_data ->> 'id'::text)) STORED NOT NULL
);


--
-- Name: reviews; Type: TABLE; Schema: stripe; Owner: -
--

CREATE TABLE stripe.reviews (
    _updated_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    _last_synced_at timestamp with time zone,
    _raw_data jsonb,
    _account_id text NOT NULL,
    object text GENERATED ALWAYS AS ((_raw_data ->> 'object'::text)) STORED,
    billing_zip text GENERATED ALWAYS AS ((_raw_data ->> 'billing_zip'::text)) STORED,
    charge text GENERATED ALWAYS AS ((_raw_data ->> 'charge'::text)) STORED,
    created integer GENERATED ALWAYS AS (((_raw_data ->> 'created'::text))::integer) STORED,
    closed_reason text GENERATED ALWAYS AS ((_raw_data ->> 'closed_reason'::text)) STORED,
    livemode boolean GENERATED ALWAYS AS (((_raw_data ->> 'livemode'::text))::boolean) STORED,
    ip_address text GENERATED ALWAYS AS ((_raw_data ->> 'ip_address'::text)) STORED,
    ip_address_location jsonb GENERATED ALWAYS AS ((_raw_data -> 'ip_address_location'::text)) STORED,
    open boolean GENERATED ALWAYS AS (((_raw_data ->> 'open'::text))::boolean) STORED,
    opened_reason text GENERATED ALWAYS AS ((_raw_data ->> 'opened_reason'::text)) STORED,
    payment_intent text GENERATED ALWAYS AS ((_raw_data ->> 'payment_intent'::text)) STORED,
    reason text GENERATED ALWAYS AS ((_raw_data ->> 'reason'::text)) STORED,
    session text GENERATED ALWAYS AS ((_raw_data ->> 'session'::text)) STORED,
    id text GENERATED ALWAYS AS ((_raw_data ->> 'id'::text)) STORED NOT NULL
);


--
-- Name: setup_intents; Type: TABLE; Schema: stripe; Owner: -
--

CREATE TABLE stripe.setup_intents (
    _last_synced_at timestamp with time zone,
    _raw_data jsonb,
    _account_id text NOT NULL,
    object text GENERATED ALWAYS AS ((_raw_data ->> 'object'::text)) STORED,
    created integer GENERATED ALWAYS AS (((_raw_data ->> 'created'::text))::integer) STORED,
    customer text GENERATED ALWAYS AS ((_raw_data ->> 'customer'::text)) STORED,
    description text GENERATED ALWAYS AS ((_raw_data ->> 'description'::text)) STORED,
    payment_method text GENERATED ALWAYS AS ((_raw_data ->> 'payment_method'::text)) STORED,
    status text GENERATED ALWAYS AS ((_raw_data ->> 'status'::text)) STORED,
    usage text GENERATED ALWAYS AS ((_raw_data ->> 'usage'::text)) STORED,
    cancellation_reason text GENERATED ALWAYS AS ((_raw_data ->> 'cancellation_reason'::text)) STORED,
    latest_attempt text GENERATED ALWAYS AS ((_raw_data ->> 'latest_attempt'::text)) STORED,
    mandate text GENERATED ALWAYS AS ((_raw_data ->> 'mandate'::text)) STORED,
    single_use_mandate text GENERATED ALWAYS AS ((_raw_data ->> 'single_use_mandate'::text)) STORED,
    on_behalf_of text GENERATED ALWAYS AS ((_raw_data ->> 'on_behalf_of'::text)) STORED,
    id text GENERATED ALWAYS AS ((_raw_data ->> 'id'::text)) STORED NOT NULL
);


--
-- Name: subscription_items; Type: TABLE; Schema: stripe; Owner: -
--

CREATE TABLE stripe.subscription_items (
    _last_synced_at timestamp with time zone,
    _raw_data jsonb,
    _account_id text NOT NULL,
    object text GENERATED ALWAYS AS ((_raw_data ->> 'object'::text)) STORED,
    billing_thresholds jsonb GENERATED ALWAYS AS ((_raw_data -> 'billing_thresholds'::text)) STORED,
    created integer GENERATED ALWAYS AS (((_raw_data ->> 'created'::text))::integer) STORED,
    deleted boolean GENERATED ALWAYS AS (((_raw_data ->> 'deleted'::text))::boolean) STORED,
    metadata jsonb GENERATED ALWAYS AS ((_raw_data -> 'metadata'::text)) STORED,
    quantity integer GENERATED ALWAYS AS (((_raw_data ->> 'quantity'::text))::integer) STORED,
    price text GENERATED ALWAYS AS ((_raw_data ->> 'price'::text)) STORED,
    subscription text GENERATED ALWAYS AS ((_raw_data ->> 'subscription'::text)) STORED,
    tax_rates jsonb GENERATED ALWAYS AS ((_raw_data -> 'tax_rates'::text)) STORED,
    current_period_end integer GENERATED ALWAYS AS (((_raw_data ->> 'current_period_end'::text))::integer) STORED,
    current_period_start integer GENERATED ALWAYS AS (((_raw_data ->> 'current_period_start'::text))::integer) STORED,
    id text GENERATED ALWAYS AS ((_raw_data ->> 'id'::text)) STORED NOT NULL
);


--
-- Name: subscription_schedules; Type: TABLE; Schema: stripe; Owner: -
--

CREATE TABLE stripe.subscription_schedules (
    _last_synced_at timestamp with time zone,
    _raw_data jsonb,
    _account_id text NOT NULL,
    object text GENERATED ALWAYS AS ((_raw_data ->> 'object'::text)) STORED,
    application text GENERATED ALWAYS AS ((_raw_data ->> 'application'::text)) STORED,
    canceled_at integer GENERATED ALWAYS AS (((_raw_data ->> 'canceled_at'::text))::integer) STORED,
    completed_at integer GENERATED ALWAYS AS (((_raw_data ->> 'completed_at'::text))::integer) STORED,
    created integer GENERATED ALWAYS AS (((_raw_data ->> 'created'::text))::integer) STORED,
    current_phase jsonb GENERATED ALWAYS AS ((_raw_data -> 'current_phase'::text)) STORED,
    customer text GENERATED ALWAYS AS ((_raw_data ->> 'customer'::text)) STORED,
    default_settings jsonb GENERATED ALWAYS AS ((_raw_data -> 'default_settings'::text)) STORED,
    end_behavior text GENERATED ALWAYS AS ((_raw_data ->> 'end_behavior'::text)) STORED,
    livemode boolean GENERATED ALWAYS AS (((_raw_data ->> 'livemode'::text))::boolean) STORED,
    metadata jsonb GENERATED ALWAYS AS ((_raw_data -> 'metadata'::text)) STORED,
    phases jsonb GENERATED ALWAYS AS ((_raw_data -> 'phases'::text)) STORED,
    released_at integer GENERATED ALWAYS AS (((_raw_data ->> 'released_at'::text))::integer) STORED,
    released_subscription text GENERATED ALWAYS AS ((_raw_data ->> 'released_subscription'::text)) STORED,
    status text GENERATED ALWAYS AS ((_raw_data ->> 'status'::text)) STORED,
    subscription text GENERATED ALWAYS AS ((_raw_data ->> 'subscription'::text)) STORED,
    test_clock text GENERATED ALWAYS AS ((_raw_data ->> 'test_clock'::text)) STORED,
    id text GENERATED ALWAYS AS ((_raw_data ->> 'id'::text)) STORED NOT NULL
);


--
-- Name: subscriptions; Type: TABLE; Schema: stripe; Owner: -
--

CREATE TABLE stripe.subscriptions (
    _updated_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    _last_synced_at timestamp with time zone,
    _raw_data jsonb,
    _account_id text NOT NULL,
    object text GENERATED ALWAYS AS ((_raw_data ->> 'object'::text)) STORED,
    cancel_at_period_end boolean GENERATED ALWAYS AS (((_raw_data ->> 'cancel_at_period_end'::text))::boolean) STORED,
    current_period_end integer GENERATED ALWAYS AS (((_raw_data ->> 'current_period_end'::text))::integer) STORED,
    current_period_start integer GENERATED ALWAYS AS (((_raw_data ->> 'current_period_start'::text))::integer) STORED,
    default_payment_method text GENERATED ALWAYS AS ((_raw_data ->> 'default_payment_method'::text)) STORED,
    items jsonb GENERATED ALWAYS AS ((_raw_data -> 'items'::text)) STORED,
    metadata jsonb GENERATED ALWAYS AS ((_raw_data -> 'metadata'::text)) STORED,
    pending_setup_intent text GENERATED ALWAYS AS ((_raw_data ->> 'pending_setup_intent'::text)) STORED,
    pending_update jsonb GENERATED ALWAYS AS ((_raw_data -> 'pending_update'::text)) STORED,
    status text GENERATED ALWAYS AS ((_raw_data ->> 'status'::text)) STORED,
    application_fee_percent double precision GENERATED ALWAYS AS (((_raw_data ->> 'application_fee_percent'::text))::double precision) STORED,
    billing_cycle_anchor integer GENERATED ALWAYS AS (((_raw_data ->> 'billing_cycle_anchor'::text))::integer) STORED,
    billing_thresholds jsonb GENERATED ALWAYS AS ((_raw_data -> 'billing_thresholds'::text)) STORED,
    cancel_at integer GENERATED ALWAYS AS (((_raw_data ->> 'cancel_at'::text))::integer) STORED,
    canceled_at integer GENERATED ALWAYS AS (((_raw_data ->> 'canceled_at'::text))::integer) STORED,
    collection_method text GENERATED ALWAYS AS ((_raw_data ->> 'collection_method'::text)) STORED,
    created integer GENERATED ALWAYS AS (((_raw_data ->> 'created'::text))::integer) STORED,
    days_until_due integer GENERATED ALWAYS AS (((_raw_data ->> 'days_until_due'::text))::integer) STORED,
    default_source text GENERATED ALWAYS AS ((_raw_data ->> 'default_source'::text)) STORED,
    default_tax_rates jsonb GENERATED ALWAYS AS ((_raw_data -> 'default_tax_rates'::text)) STORED,
    discount jsonb GENERATED ALWAYS AS ((_raw_data -> 'discount'::text)) STORED,
    ended_at integer GENERATED ALWAYS AS (((_raw_data ->> 'ended_at'::text))::integer) STORED,
    livemode boolean GENERATED ALWAYS AS (((_raw_data ->> 'livemode'::text))::boolean) STORED,
    next_pending_invoice_item_invoice integer GENERATED ALWAYS AS (((_raw_data ->> 'next_pending_invoice_item_invoice'::text))::integer) STORED,
    pause_collection jsonb GENERATED ALWAYS AS ((_raw_data -> 'pause_collection'::text)) STORED,
    pending_invoice_item_interval jsonb GENERATED ALWAYS AS ((_raw_data -> 'pending_invoice_item_interval'::text)) STORED,
    start_date integer GENERATED ALWAYS AS (((_raw_data ->> 'start_date'::text))::integer) STORED,
    transfer_data jsonb GENERATED ALWAYS AS ((_raw_data -> 'transfer_data'::text)) STORED,
    trial_end jsonb GENERATED ALWAYS AS ((_raw_data -> 'trial_end'::text)) STORED,
    trial_start jsonb GENERATED ALWAYS AS ((_raw_data -> 'trial_start'::text)) STORED,
    schedule text GENERATED ALWAYS AS ((_raw_data ->> 'schedule'::text)) STORED,
    customer text GENERATED ALWAYS AS ((_raw_data ->> 'customer'::text)) STORED,
    latest_invoice text GENERATED ALWAYS AS ((_raw_data ->> 'latest_invoice'::text)) STORED,
    plan text GENERATED ALWAYS AS ((_raw_data ->> 'plan'::text)) STORED,
    id text GENERATED ALWAYS AS ((_raw_data ->> 'id'::text)) STORED NOT NULL
);


--
-- Name: tax_ids; Type: TABLE; Schema: stripe; Owner: -
--

CREATE TABLE stripe.tax_ids (
    _last_synced_at timestamp with time zone,
    _raw_data jsonb,
    _account_id text NOT NULL,
    object text GENERATED ALWAYS AS ((_raw_data ->> 'object'::text)) STORED,
    country text GENERATED ALWAYS AS ((_raw_data ->> 'country'::text)) STORED,
    customer text GENERATED ALWAYS AS ((_raw_data ->> 'customer'::text)) STORED,
    type text GENERATED ALWAYS AS ((_raw_data ->> 'type'::text)) STORED,
    value text GENERATED ALWAYS AS ((_raw_data ->> 'value'::text)) STORED,
    created integer GENERATED ALWAYS AS (((_raw_data ->> 'created'::text))::integer) STORED,
    livemode boolean GENERATED ALWAYS AS (((_raw_data ->> 'livemode'::text))::boolean) STORED,
    owner jsonb GENERATED ALWAYS AS ((_raw_data -> 'owner'::text)) STORED,
    id text GENERATED ALWAYS AS ((_raw_data ->> 'id'::text)) STORED NOT NULL
);


--
-- Name: __drizzle_migrations id; Type: DEFAULT; Schema: drizzle; Owner: -
--

ALTER TABLE ONLY drizzle.__drizzle_migrations ALTER COLUMN id SET DEFAULT nextval('drizzle.__drizzle_migrations_id_seq'::regclass);


--
-- Name: __drizzle_migrations id; Type: DEFAULT; Schema: drizzle_test; Owner: -
--

ALTER TABLE ONLY drizzle_test.__drizzle_migrations ALTER COLUMN id SET DEFAULT nextval('drizzle_test.__drizzle_migrations_id_seq'::regclass);


--
-- Name: activity_feed id; Type: DEFAULT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.activity_feed ALTER COLUMN id SET DEFAULT nextval('heliumdb_test.activity_feed_id_seq'::regclass);


--
-- Name: affiliate_clicks id; Type: DEFAULT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.affiliate_clicks ALTER COLUMN id SET DEFAULT nextval('heliumdb_test.affiliate_clicks_id_seq'::regclass);


--
-- Name: comments id; Type: DEFAULT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.comments ALTER COLUMN id SET DEFAULT nextval('heliumdb_test.comments_id_seq'::regclass);


--
-- Name: email_verification_tokens id; Type: DEFAULT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.email_verification_tokens ALTER COLUMN id SET DEFAULT nextval('heliumdb_test.email_verification_tokens_id_seq'::regclass);


--
-- Name: enrichment_override_history id; Type: DEFAULT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.enrichment_override_history ALTER COLUMN id SET DEFAULT nextval('heliumdb_test.enrichment_override_history_id_seq'::regclass);


--
-- Name: external_links id; Type: DEFAULT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.external_links ALTER COLUMN id SET DEFAULT nextval('heliumdb_test.external_links_id_seq'::regclass);


--
-- Name: facts id; Type: DEFAULT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.facts ALTER COLUMN id SET DEFAULT nextval('heliumdb_test.facts_id_seq'::regclass);


--
-- Name: hashtags id; Type: DEFAULT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.hashtags ALTER COLUMN id SET DEFAULT nextval('heliumdb_test.hashtags_id_seq'::regclass);


--
-- Name: hero_examples id; Type: DEFAULT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.hero_examples ALTER COLUMN id SET DEFAULT nextval('heliumdb_test.hero_examples_id_seq'::regclass);


--
-- Name: image_prompt_attempts id; Type: DEFAULT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.image_prompt_attempts ALTER COLUMN id SET DEFAULT nextval('heliumdb_test.image_prompt_attempts_id_seq'::regclass);


--
-- Name: memes id; Type: DEFAULT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.memes ALTER COLUMN id SET DEFAULT nextval('heliumdb_test.memes_id_seq'::regclass);


--
-- Name: ncmec_reports id; Type: DEFAULT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.ncmec_reports ALTER COLUMN id SET DEFAULT nextval('heliumdb_test.ncmec_reports_id_seq'::regclass);


--
-- Name: password_reset_tokens id; Type: DEFAULT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.password_reset_tokens ALTER COLUMN id SET DEFAULT nextval('heliumdb_test.password_reset_tokens_id_seq'::regclass);


--
-- Name: pending_reviews id; Type: DEFAULT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.pending_reviews ALTER COLUMN id SET DEFAULT nextval('heliumdb_test.pending_reviews_id_seq'::regclass);


--
-- Name: quarantined_memes id; Type: DEFAULT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.quarantined_memes ALTER COLUMN id SET DEFAULT nextval('heliumdb_test.quarantined_memes_id_seq'::regclass);


--
-- Name: reactions id; Type: DEFAULT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.reactions ALTER COLUMN id SET DEFAULT nextval('heliumdb_test.reactions_id_seq'::regclass);


--
-- Name: route_stat_events id; Type: DEFAULT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.route_stat_events ALTER COLUMN id SET DEFAULT nextval('heliumdb_test.route_stat_events_id_seq'::regclass);


--
-- Name: search_history id; Type: DEFAULT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.search_history ALTER COLUMN id SET DEFAULT nextval('heliumdb_test.search_history_id_seq'::regclass);


--
-- Name: share_intents id; Type: DEFAULT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.share_intents ALTER COLUMN id SET DEFAULT nextval('heliumdb_test.share_intents_id_seq'::regclass);


--
-- Name: user_ai_images id; Type: DEFAULT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.user_ai_images ALTER COLUMN id SET DEFAULT nextval('heliumdb_test.user_ai_images_id_seq'::regclass);


--
-- Name: user_fact_preferences id; Type: DEFAULT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.user_fact_preferences ALTER COLUMN id SET DEFAULT nextval('heliumdb_test.user_fact_preferences_id_seq'::regclass);


--
-- Name: user_generation_costs id; Type: DEFAULT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.user_generation_costs ALTER COLUMN id SET DEFAULT nextval('heliumdb_test.user_generation_costs_id_seq'::regclass);


--
-- Name: video_jobs id; Type: DEFAULT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.video_jobs ALTER COLUMN id SET DEFAULT nextval('heliumdb_test.video_jobs_id_seq'::regclass);


--
-- Name: activity_feed id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activity_feed ALTER COLUMN id SET DEFAULT nextval('public.activity_feed_id_seq'::regclass);


--
-- Name: comments id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.comments ALTER COLUMN id SET DEFAULT nextval('public.comments_id_seq'::regclass);


--
-- Name: email_verification_tokens id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_verification_tokens ALTER COLUMN id SET DEFAULT nextval('public.email_verification_tokens_id_seq'::regclass);


--
-- Name: engine_revision_bumps id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.engine_revision_bumps ALTER COLUMN id SET DEFAULT nextval('public.engine_revision_bumps_id_seq'::regclass);


--
-- Name: enrichment_override_history id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.enrichment_override_history ALTER COLUMN id SET DEFAULT nextval('public.enrichment_override_history_id_seq'::regclass);


--
-- Name: eval_runs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.eval_runs ALTER COLUMN id SET DEFAULT nextval('public.eval_runs_id_seq'::regclass);


--
-- Name: external_links id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.external_links ALTER COLUMN id SET DEFAULT nextval('public.external_links_id_seq'::regclass);


--
-- Name: fact_enrichment_versions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fact_enrichment_versions ALTER COLUMN id SET DEFAULT nextval('public.fact_enrichment_versions_id_seq'::regclass);


--
-- Name: fact_text_edit_history id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fact_text_edit_history ALTER COLUMN id SET DEFAULT nextval('public.fact_text_edit_history_id_seq'::regclass);


--
-- Name: facts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.facts ALTER COLUMN id SET DEFAULT nextval('public.facts_id_seq'::regclass);


--
-- Name: feature_permissions_migration_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feature_permissions_migration_log ALTER COLUMN id SET DEFAULT nextval('public.feature_permissions_migration_log_id_seq'::regclass);


--
-- Name: hashtags id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hashtags ALTER COLUMN id SET DEFAULT nextval('public.hashtags_id_seq'::regclass);


--
-- Name: image_prompt_attempts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.image_prompt_attempts ALTER COLUMN id SET DEFAULT nextval('public.image_prompt_attempts_id_seq'::regclass);


--
-- Name: memes id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memes ALTER COLUMN id SET DEFAULT nextval('public.memes_id_seq'::regclass);


--
-- Name: ncmec_reports id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ncmec_reports ALTER COLUMN id SET DEFAULT nextval('public.ncmec_reports_id_seq'::regclass);


--
-- Name: ncmec_safety_audit_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ncmec_safety_audit_log ALTER COLUMN id SET DEFAULT nextval('public.ncmec_safety_audit_log_id_seq'::regclass);


--
-- Name: password_reset_tokens id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.password_reset_tokens ALTER COLUMN id SET DEFAULT nextval('public.password_reset_tokens_id_seq'::regclass);


--
-- Name: pending_reviews id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pending_reviews ALTER COLUMN id SET DEFAULT nextval('public.pending_reviews_id_seq'::regclass);


--
-- Name: quarantined_memes id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quarantined_memes ALTER COLUMN id SET DEFAULT nextval('public.quarantined_memes_id_seq'::regclass);


--
-- Name: reactions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reactions ALTER COLUMN id SET DEFAULT nextval('public.reactions_id_seq'::regclass);


--
-- Name: search_history id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.search_history ALTER COLUMN id SET DEFAULT nextval('public.search_history_id_seq'::regclass);


--
-- Name: share_intents id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.share_intents ALTER COLUMN id SET DEFAULT nextval('public.share_intents_id_seq'::regclass);


--
-- Name: tier_feature_permission_audit id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tier_feature_permission_audit ALTER COLUMN id SET DEFAULT nextval('public.tier_feature_permission_audit_id_seq'::regclass);


--
-- Name: user_ai_images id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_ai_images ALTER COLUMN id SET DEFAULT nextval('public.user_ai_images_id_seq'::regclass);


--
-- Name: user_fact_preferences id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_fact_preferences ALTER COLUMN id SET DEFAULT nextval('public.user_fact_preferences_id_seq'::regclass);


--
-- Name: user_generation_costs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_generation_costs ALTER COLUMN id SET DEFAULT nextval('public.user_generation_costs_id_seq'::regclass);


--
-- Name: _sync_status id; Type: DEFAULT; Schema: stripe; Owner: -
--

ALTER TABLE ONLY stripe._sync_status ALTER COLUMN id SET DEFAULT nextval('stripe._sync_status_id_seq'::regclass);


--
-- Name: __drizzle_migrations __drizzle_migrations_pkey; Type: CONSTRAINT; Schema: drizzle; Owner: -
--

ALTER TABLE ONLY drizzle.__drizzle_migrations
    ADD CONSTRAINT __drizzle_migrations_pkey PRIMARY KEY (id);


--
-- Name: __drizzle_migrations __drizzle_migrations_pkey; Type: CONSTRAINT; Schema: drizzle_test; Owner: -
--

ALTER TABLE ONLY drizzle_test.__drizzle_migrations
    ADD CONSTRAINT __drizzle_migrations_pkey PRIMARY KEY (id);


--
-- Name: activity_feed activity_feed_pkey; Type: CONSTRAINT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.activity_feed
    ADD CONSTRAINT activity_feed_pkey PRIMARY KEY (id);


--
-- Name: admin_config admin_config_pkey; Type: CONSTRAINT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.admin_config
    ADD CONSTRAINT admin_config_pkey PRIMARY KEY (key);


--
-- Name: affiliate_clicks affiliate_clicks_pkey; Type: CONSTRAINT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.affiliate_clicks
    ADD CONSTRAINT affiliate_clicks_pkey PRIMARY KEY (id);


--
-- Name: comments comments_pkey; Type: CONSTRAINT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.comments
    ADD CONSTRAINT comments_pkey PRIMARY KEY (id);


--
-- Name: async_jobs email_outbox_pkey; Type: CONSTRAINT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.async_jobs
    ADD CONSTRAINT email_outbox_pkey PRIMARY KEY (id);


--
-- Name: email_verification_tokens email_verification_tokens_pkey; Type: CONSTRAINT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.email_verification_tokens
    ADD CONSTRAINT email_verification_tokens_pkey PRIMARY KEY (id);


--
-- Name: engines engines_pkey; Type: CONSTRAINT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.engines
    ADD CONSTRAINT engines_pkey PRIMARY KEY (id);


--
-- Name: enrichment_override_history enrichment_override_history_pkey; Type: CONSTRAINT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.enrichment_override_history
    ADD CONSTRAINT enrichment_override_history_pkey PRIMARY KEY (id);


--
-- Name: external_links external_links_pkey; Type: CONSTRAINT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.external_links
    ADD CONSTRAINT external_links_pkey PRIMARY KEY (id);


--
-- Name: fact_hashtags fact_hashtags_fact_id_hashtag_id_unique; Type: CONSTRAINT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.fact_hashtags
    ADD CONSTRAINT fact_hashtags_fact_id_hashtag_id_unique UNIQUE (fact_id, hashtag_id);


--
-- Name: facts facts_pkey; Type: CONSTRAINT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.facts
    ADD CONSTRAINT facts_pkey PRIMARY KEY (id);


--
-- Name: fal_pricing_cache fal_pricing_cache_pkey; Type: CONSTRAINT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.fal_pricing_cache
    ADD CONSTRAINT fal_pricing_cache_pkey PRIMARY KEY (endpoint_id);


--
-- Name: feature_flags feature_flags_pkey; Type: CONSTRAINT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.feature_flags
    ADD CONSTRAINT feature_flags_pkey PRIMARY KEY (key);


--
-- Name: hashtags hashtags_name_unique; Type: CONSTRAINT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.hashtags
    ADD CONSTRAINT hashtags_name_unique UNIQUE (name);


--
-- Name: hashtags hashtags_pkey; Type: CONSTRAINT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.hashtags
    ADD CONSTRAINT hashtags_pkey PRIMARY KEY (id);


--
-- Name: hero_examples hero_examples_pkey; Type: CONSTRAINT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.hero_examples
    ADD CONSTRAINT hero_examples_pkey PRIMARY KEY (id);


--
-- Name: image_prompt_attempts image_prompt_attempts_pkey; Type: CONSTRAINT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.image_prompt_attempts
    ADD CONSTRAINT image_prompt_attempts_pkey PRIMARY KEY (id);


--
-- Name: lifetime_entitlements lifetime_entitlements_pkey; Type: CONSTRAINT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.lifetime_entitlements
    ADD CONSTRAINT lifetime_entitlements_pkey PRIMARY KEY (id);


--
-- Name: lifetime_entitlements lifetime_entitlements_stripe_payment_intent_id_unique; Type: CONSTRAINT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.lifetime_entitlements
    ADD CONSTRAINT lifetime_entitlements_stripe_payment_intent_id_unique UNIQUE (stripe_payment_intent_id);


--
-- Name: look_styles look_styles_pkey; Type: CONSTRAINT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.look_styles
    ADD CONSTRAINT look_styles_pkey PRIMARY KEY (id);


--
-- Name: membership_history membership_history_pkey; Type: CONSTRAINT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.membership_history
    ADD CONSTRAINT membership_history_pkey PRIMARY KEY (id);


--
-- Name: memes memes_permalink_slug_unique; Type: CONSTRAINT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.memes
    ADD CONSTRAINT memes_permalink_slug_unique UNIQUE (permalink_slug);


--
-- Name: memes memes_pkey; Type: CONSTRAINT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.memes
    ADD CONSTRAINT memes_pkey PRIMARY KEY (id);


--
-- Name: ncmec_reports ncmec_reports_pkey; Type: CONSTRAINT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.ncmec_reports
    ADD CONSTRAINT ncmec_reports_pkey PRIMARY KEY (id);


--
-- Name: oauth_pending_states oauth_pending_states_pkey; Type: CONSTRAINT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.oauth_pending_states
    ADD CONSTRAINT oauth_pending_states_pkey PRIMARY KEY (state);


--
-- Name: password_reset_tokens password_reset_tokens_pkey; Type: CONSTRAINT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.password_reset_tokens
    ADD CONSTRAINT password_reset_tokens_pkey PRIMARY KEY (id);


--
-- Name: pending_reviews pending_reviews_pkey; Type: CONSTRAINT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.pending_reviews
    ADD CONSTRAINT pending_reviews_pkey PRIMARY KEY (id);


--
-- Name: quarantined_memes quarantined_memes_pkey; Type: CONSTRAINT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.quarantined_memes
    ADD CONSTRAINT quarantined_memes_pkey PRIMARY KEY (id);


--
-- Name: rate_limit_counters rate_limit_counters_pkey; Type: CONSTRAINT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.rate_limit_counters
    ADD CONSTRAINT rate_limit_counters_pkey PRIMARY KEY (key_hash);


--
-- Name: ratings ratings_fact_id_user_id_unique; Type: CONSTRAINT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.ratings
    ADD CONSTRAINT ratings_fact_id_user_id_unique UNIQUE (fact_id, user_id);


--
-- Name: reactions reactions_pkey; Type: CONSTRAINT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.reactions
    ADD CONSTRAINT reactions_pkey PRIMARY KEY (id);


--
-- Name: reference_research_cache reference_research_cache_pkey; Type: CONSTRAINT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.reference_research_cache
    ADD CONSTRAINT reference_research_cache_pkey PRIMARY KEY (cache_key);


--
-- Name: route_stat_events route_stat_events_pkey; Type: CONSTRAINT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.route_stat_events
    ADD CONSTRAINT route_stat_events_pkey PRIMARY KEY (id);


--
-- Name: route_stats route_stats_pkey; Type: CONSTRAINT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.route_stats
    ADD CONSTRAINT route_stats_pkey PRIMARY KEY (route_key);


--
-- Name: search_history search_history_pkey; Type: CONSTRAINT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.search_history
    ADD CONSTRAINT search_history_pkey PRIMARY KEY (id);


--
-- Name: sessions sessions_pkey; Type: CONSTRAINT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (sid);


--
-- Name: share_intents share_intents_pkey; Type: CONSTRAINT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.share_intents
    ADD CONSTRAINT share_intents_pkey PRIMARY KEY (id);


--
-- Name: stripe_checkout_request_ledger stripe_checkout_request_ledger_pkey; Type: CONSTRAINT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.stripe_checkout_request_ledger
    ADD CONSTRAINT stripe_checkout_request_ledger_pkey PRIMARY KEY (id);


--
-- Name: stripe_checkout_request_ledger stripe_checkout_request_ledger_request_key_unique; Type: CONSTRAINT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.stripe_checkout_request_ledger
    ADD CONSTRAINT stripe_checkout_request_ledger_request_key_unique UNIQUE (request_key);


--
-- Name: stripe_processed_events stripe_processed_events_pkey; Type: CONSTRAINT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.stripe_processed_events
    ADD CONSTRAINT stripe_processed_events_pkey PRIMARY KEY (event_id);


--
-- Name: stripe_webhook_audit stripe_webhook_audit_pkey; Type: CONSTRAINT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.stripe_webhook_audit
    ADD CONSTRAINT stripe_webhook_audit_pkey PRIMARY KEY (id);


--
-- Name: subscriptions subscriptions_pkey; Type: CONSTRAINT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.subscriptions
    ADD CONSTRAINT subscriptions_pkey PRIMARY KEY (id);


--
-- Name: subscriptions subscriptions_stripe_subscription_id_unique; Type: CONSTRAINT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.subscriptions
    ADD CONSTRAINT subscriptions_stripe_subscription_id_unique UNIQUE (stripe_subscription_id);


--
-- Name: tier_feature_permissions tier_feature_permissions_tier_feature_key_pk; Type: CONSTRAINT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.tier_feature_permissions
    ADD CONSTRAINT tier_feature_permissions_tier_feature_key_pk PRIMARY KEY (tier, feature_key);


--
-- Name: transient_renders transient_renders_pkey; Type: CONSTRAINT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.transient_renders
    ADD CONSTRAINT transient_renders_pkey PRIMARY KEY (id);


--
-- Name: upload_image_metadata upload_image_metadata_pkey; Type: CONSTRAINT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.upload_image_metadata
    ADD CONSTRAINT upload_image_metadata_pkey PRIMARY KEY (object_path);


--
-- Name: user_ai_images user_ai_images_pkey; Type: CONSTRAINT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.user_ai_images
    ADD CONSTRAINT user_ai_images_pkey PRIMARY KEY (id);


--
-- Name: user_fact_preferences user_fact_preferences_pkey; Type: CONSTRAINT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.user_fact_preferences
    ADD CONSTRAINT user_fact_preferences_pkey PRIMARY KEY (id);


--
-- Name: user_generation_costs user_generation_costs_pkey; Type: CONSTRAINT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.user_generation_costs
    ADD CONSTRAINT user_generation_costs_pkey PRIMARY KEY (id);


--
-- Name: users users_email_unique; Type: CONSTRAINT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.users
    ADD CONSTRAINT users_email_unique UNIQUE (email);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: users users_stripe_customer_id_unique; Type: CONSTRAINT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.users
    ADD CONSTRAINT users_stripe_customer_id_unique UNIQUE (stripe_customer_id);


--
-- Name: video_jobs video_jobs_pkey; Type: CONSTRAINT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.video_jobs
    ADD CONSTRAINT video_jobs_pkey PRIMARY KEY (id);


--
-- Name: motion_presets video_styles_pkey; Type: CONSTRAINT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.motion_presets
    ADD CONSTRAINT video_styles_pkey PRIMARY KEY (id);


--
-- Name: activity_feed activity_feed_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activity_feed
    ADD CONSTRAINT activity_feed_pkey PRIMARY KEY (id);


--
-- Name: admin_config admin_config_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_config
    ADD CONSTRAINT admin_config_pkey PRIMARY KEY (key);


--
-- Name: comments comments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.comments
    ADD CONSTRAINT comments_pkey PRIMARY KEY (id);


--
-- Name: async_jobs email_outbox_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.async_jobs
    ADD CONSTRAINT email_outbox_pkey PRIMARY KEY (id);


--
-- Name: email_verification_tokens email_verification_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_verification_tokens
    ADD CONSTRAINT email_verification_tokens_pkey PRIMARY KEY (id);


--
-- Name: engine_revision_bumps engine_revision_bumps_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.engine_revision_bumps
    ADD CONSTRAINT engine_revision_bumps_pkey PRIMARY KEY (id);


--
-- Name: engines engines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.engines
    ADD CONSTRAINT engines_pkey PRIMARY KEY (id);


--
-- Name: enrichment_override_history enrichment_override_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.enrichment_override_history
    ADD CONSTRAINT enrichment_override_history_pkey PRIMARY KEY (id);


--
-- Name: entitlement_grid_revision entitlement_grid_revision_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entitlement_grid_revision
    ADD CONSTRAINT entitlement_grid_revision_pkey PRIMARY KEY (id);


--
-- Name: entitlement_source_disputes entitlement_source_disputes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entitlement_source_disputes
    ADD CONSTRAINT entitlement_source_disputes_pkey PRIMARY KEY (stripe_dispute_id);


--
-- Name: eval_runs eval_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.eval_runs
    ADD CONSTRAINT eval_runs_pkey PRIMARY KEY (id);


--
-- Name: external_links external_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.external_links
    ADD CONSTRAINT external_links_pkey PRIMARY KEY (id);


--
-- Name: fact_enrichment_versions fact_enrichment_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fact_enrichment_versions
    ADD CONSTRAINT fact_enrichment_versions_pkey PRIMARY KEY (id);


--
-- Name: fact_hashtags fact_hashtags_fact_id_hashtag_id_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fact_hashtags
    ADD CONSTRAINT fact_hashtags_fact_id_hashtag_id_unique UNIQUE (fact_id, hashtag_id);


--
-- Name: fact_text_edit_history fact_text_edit_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fact_text_edit_history
    ADD CONSTRAINT fact_text_edit_history_pkey PRIMARY KEY (id);


--
-- Name: facts facts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.facts
    ADD CONSTRAINT facts_pkey PRIMARY KEY (id);


--
-- Name: fal_pricing_cache fal_pricing_cache_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fal_pricing_cache
    ADD CONSTRAINT fal_pricing_cache_pkey PRIMARY KEY (endpoint_id);


--
-- Name: feature_flags feature_flags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feature_flags
    ADD CONSTRAINT feature_flags_pkey PRIMARY KEY (key);


--
-- Name: feature_permissions_migration_log feature_permissions_migration_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feature_permissions_migration_log
    ADD CONSTRAINT feature_permissions_migration_log_pkey PRIMARY KEY (id);


--
-- Name: hashtags hashtags_name_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hashtags
    ADD CONSTRAINT hashtags_name_unique UNIQUE (name);


--
-- Name: hashtags hashtags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hashtags
    ADD CONSTRAINT hashtags_pkey PRIMARY KEY (id);


--
-- Name: image_prompt_attempts image_prompt_attempts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.image_prompt_attempts
    ADD CONSTRAINT image_prompt_attempts_pkey PRIMARY KEY (id);


--
-- Name: look_styles look_styles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.look_styles
    ADD CONSTRAINT look_styles_pkey PRIMARY KEY (id);


--
-- Name: membership_entitlements membership_entitlements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.membership_entitlements
    ADD CONSTRAINT membership_entitlements_pkey PRIMARY KEY (id);


--
-- Name: membership_history membership_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.membership_history
    ADD CONSTRAINT membership_history_pkey PRIMARY KEY (id);


--
-- Name: membership_leases membership_leases_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.membership_leases
    ADD CONSTRAINT membership_leases_pkey PRIMARY KEY (scope);


--
-- Name: memes memes_permalink_slug_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memes
    ADD CONSTRAINT memes_permalink_slug_unique UNIQUE (permalink_slug);


--
-- Name: memes memes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memes
    ADD CONSTRAINT memes_pkey PRIMARY KEY (id);


--
-- Name: ncmec_reports ncmec_reports_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ncmec_reports
    ADD CONSTRAINT ncmec_reports_pkey PRIMARY KEY (id);


--
-- Name: ncmec_safety_audit_log ncmec_safety_audit_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ncmec_safety_audit_log
    ADD CONSTRAINT ncmec_safety_audit_log_pkey PRIMARY KEY (id);


--
-- Name: oauth_pending_states oauth_pending_states_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_pending_states
    ADD CONSTRAINT oauth_pending_states_pkey PRIMARY KEY (state);


--
-- Name: password_reset_tokens password_reset_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.password_reset_tokens
    ADD CONSTRAINT password_reset_tokens_pkey PRIMARY KEY (id);


--
-- Name: pending_reviews pending_reviews_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pending_reviews
    ADD CONSTRAINT pending_reviews_pkey PRIMARY KEY (id);


--
-- Name: quarantined_memes quarantined_memes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quarantined_memes
    ADD CONSTRAINT quarantined_memes_pkey PRIMARY KEY (id);


--
-- Name: rate_limit_counters rate_limit_counters_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rate_limit_counters
    ADD CONSTRAINT rate_limit_counters_pkey PRIMARY KEY (key_hash);


--
-- Name: reactions reactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reactions
    ADD CONSTRAINT reactions_pkey PRIMARY KEY (id);


--
-- Name: reference_research_cache reference_research_cache_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reference_research_cache
    ADD CONSTRAINT reference_research_cache_pkey PRIMARY KEY (cache_key);


--
-- Name: search_history search_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.search_history
    ADD CONSTRAINT search_history_pkey PRIMARY KEY (id);


--
-- Name: sessions sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (sid);


--
-- Name: share_intents share_intents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.share_intents
    ADD CONSTRAINT share_intents_pkey PRIMARY KEY (id);


--
-- Name: stripe_checkout_request_ledger stripe_checkout_request_ledger_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stripe_checkout_request_ledger
    ADD CONSTRAINT stripe_checkout_request_ledger_pkey PRIMARY KEY (id);


--
-- Name: stripe_checkout_request_ledger stripe_checkout_request_ledger_request_key_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stripe_checkout_request_ledger
    ADD CONSTRAINT stripe_checkout_request_ledger_request_key_unique UNIQUE (request_key);


--
-- Name: stripe_processed_events stripe_processed_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stripe_processed_events
    ADD CONSTRAINT stripe_processed_events_pkey PRIMARY KEY (event_id);


--
-- Name: stripe_webhook_audit stripe_webhook_audit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stripe_webhook_audit
    ADD CONSTRAINT stripe_webhook_audit_pkey PRIMARY KEY (id);


--
-- Name: tier_feature_permission_audit tier_feature_permission_audit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tier_feature_permission_audit
    ADD CONSTRAINT tier_feature_permission_audit_pkey PRIMARY KEY (id);


--
-- Name: tier_feature_permissions tier_feature_permissions_tier_feature_key_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tier_feature_permissions
    ADD CONSTRAINT tier_feature_permissions_tier_feature_key_pk PRIMARY KEY (tier, feature_key);


--
-- Name: transient_renders transient_renders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transient_renders
    ADD CONSTRAINT transient_renders_pkey PRIMARY KEY (id);


--
-- Name: upload_image_metadata upload_image_metadata_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.upload_image_metadata
    ADD CONSTRAINT upload_image_metadata_pkey PRIMARY KEY (object_path);


--
-- Name: user_ai_images user_ai_images_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_ai_images
    ADD CONSTRAINT user_ai_images_pkey PRIMARY KEY (id);


--
-- Name: user_fact_preferences user_fact_preferences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_fact_preferences
    ADD CONSTRAINT user_fact_preferences_pkey PRIMARY KEY (id);


--
-- Name: user_generation_costs user_generation_costs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_generation_costs
    ADD CONSTRAINT user_generation_costs_pkey PRIMARY KEY (id);


--
-- Name: users users_email_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_unique UNIQUE (email);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: users users_stripe_customer_id_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_stripe_customer_id_unique UNIQUE (stripe_customer_id);


--
-- Name: worker_lane_heartbeats worker_lane_heartbeats_instance_id_lane_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.worker_lane_heartbeats
    ADD CONSTRAINT worker_lane_heartbeats_instance_id_lane_pk PRIMARY KEY (instance_id, lane);


--
-- Name: _migrations _migrations_name_key; Type: CONSTRAINT; Schema: stripe; Owner: -
--

ALTER TABLE ONLY stripe._migrations
    ADD CONSTRAINT _migrations_name_key UNIQUE (name);


--
-- Name: _migrations _migrations_pkey; Type: CONSTRAINT; Schema: stripe; Owner: -
--

ALTER TABLE ONLY stripe._migrations
    ADD CONSTRAINT _migrations_pkey PRIMARY KEY (id);


--
-- Name: _sync_status _sync_status_pkey; Type: CONSTRAINT; Schema: stripe; Owner: -
--

ALTER TABLE ONLY stripe._sync_status
    ADD CONSTRAINT _sync_status_pkey PRIMARY KEY (id);


--
-- Name: _sync_status _sync_status_resource_account_key; Type: CONSTRAINT; Schema: stripe; Owner: -
--

ALTER TABLE ONLY stripe._sync_status
    ADD CONSTRAINT _sync_status_resource_account_key UNIQUE (resource, account_id);


--
-- Name: accounts accounts_pkey; Type: CONSTRAINT; Schema: stripe; Owner: -
--

ALTER TABLE ONLY stripe.accounts
    ADD CONSTRAINT accounts_pkey PRIMARY KEY (id);


--
-- Name: active_entitlements active_entitlements_pkey; Type: CONSTRAINT; Schema: stripe; Owner: -
--

ALTER TABLE ONLY stripe.active_entitlements
    ADD CONSTRAINT active_entitlements_pkey PRIMARY KEY (id);


--
-- Name: charges charges_pkey; Type: CONSTRAINT; Schema: stripe; Owner: -
--

ALTER TABLE ONLY stripe.charges
    ADD CONSTRAINT charges_pkey PRIMARY KEY (id);


--
-- Name: checkout_session_line_items checkout_session_line_items_pkey; Type: CONSTRAINT; Schema: stripe; Owner: -
--

ALTER TABLE ONLY stripe.checkout_session_line_items
    ADD CONSTRAINT checkout_session_line_items_pkey PRIMARY KEY (id);


--
-- Name: checkout_sessions checkout_sessions_pkey; Type: CONSTRAINT; Schema: stripe; Owner: -
--

ALTER TABLE ONLY stripe.checkout_sessions
    ADD CONSTRAINT checkout_sessions_pkey PRIMARY KEY (id);


--
-- Name: coupons coupons_pkey; Type: CONSTRAINT; Schema: stripe; Owner: -
--

ALTER TABLE ONLY stripe.coupons
    ADD CONSTRAINT coupons_pkey PRIMARY KEY (id);


--
-- Name: credit_notes credit_notes_pkey; Type: CONSTRAINT; Schema: stripe; Owner: -
--

ALTER TABLE ONLY stripe.credit_notes
    ADD CONSTRAINT credit_notes_pkey PRIMARY KEY (id);


--
-- Name: customers customers_pkey; Type: CONSTRAINT; Schema: stripe; Owner: -
--

ALTER TABLE ONLY stripe.customers
    ADD CONSTRAINT customers_pkey PRIMARY KEY (id);


--
-- Name: disputes disputes_pkey; Type: CONSTRAINT; Schema: stripe; Owner: -
--

ALTER TABLE ONLY stripe.disputes
    ADD CONSTRAINT disputes_pkey PRIMARY KEY (id);


--
-- Name: early_fraud_warnings early_fraud_warnings_pkey; Type: CONSTRAINT; Schema: stripe; Owner: -
--

ALTER TABLE ONLY stripe.early_fraud_warnings
    ADD CONSTRAINT early_fraud_warnings_pkey PRIMARY KEY (id);


--
-- Name: events events_pkey; Type: CONSTRAINT; Schema: stripe; Owner: -
--

ALTER TABLE ONLY stripe.events
    ADD CONSTRAINT events_pkey PRIMARY KEY (id);


--
-- Name: features features_pkey; Type: CONSTRAINT; Schema: stripe; Owner: -
--

ALTER TABLE ONLY stripe.features
    ADD CONSTRAINT features_pkey PRIMARY KEY (id);


--
-- Name: invoices invoices_pkey; Type: CONSTRAINT; Schema: stripe; Owner: -
--

ALTER TABLE ONLY stripe.invoices
    ADD CONSTRAINT invoices_pkey PRIMARY KEY (id);


--
-- Name: _managed_webhooks managed_webhooks_pkey; Type: CONSTRAINT; Schema: stripe; Owner: -
--

ALTER TABLE ONLY stripe._managed_webhooks
    ADD CONSTRAINT managed_webhooks_pkey PRIMARY KEY (id);


--
-- Name: _managed_webhooks managed_webhooks_url_account_unique; Type: CONSTRAINT; Schema: stripe; Owner: -
--

ALTER TABLE ONLY stripe._managed_webhooks
    ADD CONSTRAINT managed_webhooks_url_account_unique UNIQUE (url, account_id);


--
-- Name: payment_intents payment_intents_pkey; Type: CONSTRAINT; Schema: stripe; Owner: -
--

ALTER TABLE ONLY stripe.payment_intents
    ADD CONSTRAINT payment_intents_pkey PRIMARY KEY (id);


--
-- Name: payment_methods payment_methods_pkey; Type: CONSTRAINT; Schema: stripe; Owner: -
--

ALTER TABLE ONLY stripe.payment_methods
    ADD CONSTRAINT payment_methods_pkey PRIMARY KEY (id);


--
-- Name: payouts payouts_pkey; Type: CONSTRAINT; Schema: stripe; Owner: -
--

ALTER TABLE ONLY stripe.payouts
    ADD CONSTRAINT payouts_pkey PRIMARY KEY (id);


--
-- Name: plans plans_pkey; Type: CONSTRAINT; Schema: stripe; Owner: -
--

ALTER TABLE ONLY stripe.plans
    ADD CONSTRAINT plans_pkey PRIMARY KEY (id);


--
-- Name: prices prices_pkey; Type: CONSTRAINT; Schema: stripe; Owner: -
--

ALTER TABLE ONLY stripe.prices
    ADD CONSTRAINT prices_pkey PRIMARY KEY (id);


--
-- Name: products products_pkey; Type: CONSTRAINT; Schema: stripe; Owner: -
--

ALTER TABLE ONLY stripe.products
    ADD CONSTRAINT products_pkey PRIMARY KEY (id);


--
-- Name: refunds refunds_pkey; Type: CONSTRAINT; Schema: stripe; Owner: -
--

ALTER TABLE ONLY stripe.refunds
    ADD CONSTRAINT refunds_pkey PRIMARY KEY (id);


--
-- Name: reviews reviews_pkey; Type: CONSTRAINT; Schema: stripe; Owner: -
--

ALTER TABLE ONLY stripe.reviews
    ADD CONSTRAINT reviews_pkey PRIMARY KEY (id);


--
-- Name: setup_intents setup_intents_pkey; Type: CONSTRAINT; Schema: stripe; Owner: -
--

ALTER TABLE ONLY stripe.setup_intents
    ADD CONSTRAINT setup_intents_pkey PRIMARY KEY (id);


--
-- Name: subscription_items subscription_items_pkey; Type: CONSTRAINT; Schema: stripe; Owner: -
--

ALTER TABLE ONLY stripe.subscription_items
    ADD CONSTRAINT subscription_items_pkey PRIMARY KEY (id);


--
-- Name: subscription_schedules subscription_schedules_pkey; Type: CONSTRAINT; Schema: stripe; Owner: -
--

ALTER TABLE ONLY stripe.subscription_schedules
    ADD CONSTRAINT subscription_schedules_pkey PRIMARY KEY (id);


--
-- Name: subscriptions subscriptions_pkey; Type: CONSTRAINT; Schema: stripe; Owner: -
--

ALTER TABLE ONLY stripe.subscriptions
    ADD CONSTRAINT subscriptions_pkey PRIMARY KEY (id);


--
-- Name: tax_ids tax_ids_pkey; Type: CONSTRAINT; Schema: stripe; Owner: -
--

ALTER TABLE ONLY stripe.tax_ids
    ADD CONSTRAINT tax_ids_pkey PRIMARY KEY (id);


--
-- Name: IDX_engines_kind_active; Type: INDEX; Schema: heliumdb_test; Owner: -
--

CREATE INDEX "IDX_engines_kind_active" ON heliumdb_test.engines USING btree (kind, is_active);


--
-- Name: IDX_engines_kind_default; Type: INDEX; Schema: heliumdb_test; Owner: -
--

CREATE INDEX "IDX_engines_kind_default" ON heliumdb_test.engines USING btree (kind, is_default);


--
-- Name: IDX_eoh_created_at; Type: INDEX; Schema: heliumdb_test; Owner: -
--

CREATE INDEX "IDX_eoh_created_at" ON heliumdb_test.enrichment_override_history USING btree (created_at DESC NULLS LAST);


--
-- Name: IDX_eoh_fact_id; Type: INDEX; Schema: heliumdb_test; Owner: -
--

CREATE INDEX "IDX_eoh_fact_id" ON heliumdb_test.enrichment_override_history USING btree (fact_id);


--
-- Name: IDX_evt_token_hash; Type: INDEX; Schema: heliumdb_test; Owner: -
--

CREATE INDEX "IDX_evt_token_hash" ON heliumdb_test.email_verification_tokens USING btree (token_hash);


--
-- Name: IDX_ipa_created_at; Type: INDEX; Schema: heliumdb_test; Owner: -
--

CREATE INDEX "IDX_ipa_created_at" ON heliumdb_test.image_prompt_attempts USING btree (created_at DESC NULLS LAST);


--
-- Name: IDX_ipa_fact_id; Type: INDEX; Schema: heliumdb_test; Owner: -
--

CREATE INDEX "IDX_ipa_fact_id" ON heliumdb_test.image_prompt_attempts USING btree (fact_id);


--
-- Name: IDX_ipa_subject_render_mode; Type: INDEX; Schema: heliumdb_test; Owner: -
--

CREATE INDEX "IDX_ipa_subject_render_mode" ON heliumdb_test.image_prompt_attempts USING btree (subject_render_mode);


--
-- Name: IDX_ipa_user_id; Type: INDEX; Schema: heliumdb_test; Owner: -
--

CREATE INDEX "IDX_ipa_user_id" ON heliumdb_test.image_prompt_attempts USING btree (user_id);


--
-- Name: IDX_memes_artifact_type; Type: INDEX; Schema: heliumdb_test; Owner: -
--

CREATE INDEX "IDX_memes_artifact_type" ON heliumdb_test.memes USING btree (artifact_type);


--
-- Name: IDX_memes_deleted_at; Type: INDEX; Schema: heliumdb_test; Owner: -
--

CREATE INDEX "IDX_memes_deleted_at" ON heliumdb_test.memes USING btree (deleted_at) WHERE (deleted_at IS NULL);


--
-- Name: IDX_memes_heart_count; Type: INDEX; Schema: heliumdb_test; Owner: -
--

CREATE INDEX "IDX_memes_heart_count" ON heliumdb_test.memes USING btree (heart_count);


--
-- Name: IDX_memes_status; Type: INDEX; Schema: heliumdb_test; Owner: -
--

CREATE INDEX "IDX_memes_status" ON heliumdb_test.memes USING btree (status);


--
-- Name: IDX_ncmec_status_created; Type: INDEX; Schema: heliumdb_test; Owner: -
--

CREATE INDEX "IDX_ncmec_status_created" ON heliumdb_test.ncmec_reports USING btree (submission_status, created_at);


--
-- Name: IDX_oauth_pending_states_expires_at; Type: INDEX; Schema: heliumdb_test; Owner: -
--

CREATE INDEX "IDX_oauth_pending_states_expires_at" ON heliumdb_test.oauth_pending_states USING btree (expires_at);


--
-- Name: IDX_prt_token_hash; Type: INDEX; Schema: heliumdb_test; Owner: -
--

CREATE INDEX "IDX_prt_token_hash" ON heliumdb_test.password_reset_tokens USING btree (token_hash);


--
-- Name: IDX_quarantined_live; Type: INDEX; Schema: heliumdb_test; Owner: -
--

CREATE INDEX "IDX_quarantined_live" ON heliumdb_test.quarantined_memes USING btree (id) WHERE (deleted_at IS NULL);


--
-- Name: IDX_quarantined_source_created; Type: INDEX; Schema: heliumdb_test; Owner: -
--

CREATE INDEX "IDX_quarantined_source_created" ON heliumdb_test.quarantined_memes USING btree (source, created_at DESC NULLS LAST);


--
-- Name: IDX_quarantined_user_created; Type: INDEX; Schema: heliumdb_test; Owner: -
--

CREATE INDEX "IDX_quarantined_user_created" ON heliumdb_test.quarantined_memes USING btree (user_id, created_at DESC NULLS LAST);


--
-- Name: IDX_reactions_target; Type: INDEX; Schema: heliumdb_test; Owner: -
--

CREATE INDEX "IDX_reactions_target" ON heliumdb_test.reactions USING btree (target_type, target_id);


--
-- Name: IDX_reactions_user; Type: INDEX; Schema: heliumdb_test; Owner: -
--

CREATE INDEX "IDX_reactions_user" ON heliumdb_test.reactions USING btree (user_id);


--
-- Name: IDX_reference_research_cache_created_at; Type: INDEX; Schema: heliumdb_test; Owner: -
--

CREATE INDEX "IDX_reference_research_cache_created_at" ON heliumdb_test.reference_research_cache USING btree (created_at DESC NULLS LAST);


--
-- Name: IDX_session_expire; Type: INDEX; Schema: heliumdb_test; Owner: -
--

CREATE INDEX "IDX_session_expire" ON heliumdb_test.sessions USING btree (expire);


--
-- Name: IDX_session_user_id; Type: INDEX; Schema: heliumdb_test; Owner: -
--

CREATE INDEX "IDX_session_user_id" ON heliumdb_test.sessions USING btree (user_id);


--
-- Name: IDX_uai_fact_id; Type: INDEX; Schema: heliumdb_test; Owner: -
--

CREATE INDEX "IDX_uai_fact_id" ON heliumdb_test.user_ai_images USING btree (fact_id);


--
-- Name: IDX_uai_user_id; Type: INDEX; Schema: heliumdb_test; Owner: -
--

CREATE INDEX "IDX_uai_user_id" ON heliumdb_test.user_ai_images USING btree (user_id);


--
-- Name: IDX_uim_arachnid_sha256; Type: INDEX; Schema: heliumdb_test; Owner: -
--

CREATE INDEX "IDX_uim_arachnid_sha256" ON heliumdb_test.upload_image_metadata USING btree (arachnid_sha256_hex);


--
-- Name: IDX_uim_pulid_dedup; Type: INDEX; Schema: heliumdb_test; Owner: -
--

CREATE INDEX "IDX_uim_pulid_dedup" ON heliumdb_test.upload_image_metadata USING btree (user_id, fact_id, source_object_path, transform_params_hash) WHERE ((transform)::text = 'pulid'::text);


--
-- Name: IDX_uim_user_id; Type: INDEX; Schema: heliumdb_test; Owner: -
--

CREATE INDEX "IDX_uim_user_id" ON heliumdb_test.upload_image_metadata USING btree (user_id);


--
-- Name: IDX_uim_user_transform_fact; Type: INDEX; Schema: heliumdb_test; Owner: -
--

CREATE INDEX "IDX_uim_user_transform_fact" ON heliumdb_test.upload_image_metadata USING btree (user_id, transform, fact_id);


--
-- Name: UQ_reactions_user_target_type; Type: INDEX; Schema: heliumdb_test; Owner: -
--

CREATE UNIQUE INDEX "UQ_reactions_user_target_type" ON heliumdb_test.reactions USING btree (user_id, target_type, target_id, reaction_type);


--
-- Name: async_jobs_dedupe_idx; Type: INDEX; Schema: heliumdb_test; Owner: -
--

CREATE UNIQUE INDEX async_jobs_dedupe_idx ON heliumdb_test.async_jobs USING btree (queue, dedupe_key) WHERE ((dedupe_key IS NOT NULL) AND ((status)::text = ANY (ARRAY[('pending'::character varying)::text, ('processing'::character varying)::text])));


--
-- Name: async_jobs_pending_idx; Type: INDEX; Schema: heliumdb_test; Owner: -
--

CREATE INDEX async_jobs_pending_idx ON heliumdb_test.async_jobs USING btree (queue, next_attempt_at) WHERE ((status)::text = 'pending'::text);


--
-- Name: async_jobs_status_created_idx; Type: INDEX; Schema: heliumdb_test; Owner: -
--

CREATE INDEX async_jobs_status_created_idx ON heliumdb_test.async_jobs USING btree (queue, status, created_at DESC NULLS LAST);


--
-- Name: facts_adult_suitability_idx; Type: INDEX; Schema: heliumdb_test; Owner: -
--

CREATE INDEX facts_adult_suitability_idx ON heliumdb_test.facts USING btree (adult_suitability);


--
-- Name: facts_parent_id_idx; Type: INDEX; Schema: heliumdb_test; Owner: -
--

CREATE INDEX facts_parent_id_idx ON heliumdb_test.facts USING btree (parent_id);


--
-- Name: facts_primary_archetype_idx; Type: INDEX; Schema: heliumdb_test; Owner: -
--

CREATE INDEX facts_primary_archetype_idx ON heliumdb_test.facts USING btree (primary_archetype);


--
-- Name: facts_wilson_score_idx; Type: INDEX; Schema: heliumdb_test; Owner: -
--

CREATE INDEX facts_wilson_score_idx ON heliumdb_test.facts USING btree (wilson_score DESC NULLS LAST);


--
-- Name: idx_activity_feed_user; Type: INDEX; Schema: heliumdb_test; Owner: -
--

CREATE INDEX idx_activity_feed_user ON heliumdb_test.activity_feed USING btree (user_id, created_at DESC NULLS LAST);


--
-- Name: idx_checkout_request_ledger_user_id; Type: INDEX; Schema: heliumdb_test; Owner: -
--

CREATE INDEX idx_checkout_request_ledger_user_id ON heliumdb_test.stripe_checkout_request_ledger USING btree (user_id);


--
-- Name: idx_hero_examples_type_active_sort; Type: INDEX; Schema: heliumdb_test; Owner: -
--

CREATE INDEX idx_hero_examples_type_active_sort ON heliumdb_test.hero_examples USING btree (artifact_type, active, sort_order);


--
-- Name: idx_membership_history_user_id; Type: INDEX; Schema: heliumdb_test; Owner: -
--

CREATE INDEX idx_membership_history_user_id ON heliumdb_test.membership_history USING btree (user_id);


--
-- Name: idx_pending_reviews_staging_fact; Type: INDEX; Schema: heliumdb_test; Owner: -
--

CREATE INDEX idx_pending_reviews_staging_fact ON heliumdb_test.pending_reviews USING btree (staging_fact_id);


--
-- Name: idx_pending_reviews_status; Type: INDEX; Schema: heliumdb_test; Owner: -
--

CREATE INDEX idx_pending_reviews_status ON heliumdb_test.pending_reviews USING btree (status);


--
-- Name: idx_pending_reviews_submitted_by; Type: INDEX; Schema: heliumdb_test; Owner: -
--

CREATE INDEX idx_pending_reviews_submitted_by ON heliumdb_test.pending_reviews USING btree (submitted_by_id);


--
-- Name: idx_pending_reviews_workflow_stage; Type: INDEX; Schema: heliumdb_test; Owner: -
--

CREATE INDEX idx_pending_reviews_workflow_stage ON heliumdb_test.pending_reviews USING btree (workflow_stage);


--
-- Name: idx_rate_limit_counters_expires_at; Type: INDEX; Schema: heliumdb_test; Owner: -
--

CREATE INDEX idx_rate_limit_counters_expires_at ON heliumdb_test.rate_limit_counters USING btree (expires_at);


--
-- Name: idx_share_intents_meme_created; Type: INDEX; Schema: heliumdb_test; Owner: -
--

CREATE INDEX idx_share_intents_meme_created ON heliumdb_test.share_intents USING btree (meme_id, created_at);


--
-- Name: idx_share_intents_platform_created; Type: INDEX; Schema: heliumdb_test; Owner: -
--

CREATE INDEX idx_share_intents_platform_created ON heliumdb_test.share_intents USING btree (platform, created_at);


--
-- Name: idx_share_intents_user_platform_created; Type: INDEX; Schema: heliumdb_test; Owner: -
--

CREATE INDEX idx_share_intents_user_platform_created ON heliumdb_test.share_intents USING btree (user_id, platform, created_at);


--
-- Name: idx_stripe_webhook_audit_created_at; Type: INDEX; Schema: heliumdb_test; Owner: -
--

CREATE INDEX idx_stripe_webhook_audit_created_at ON heliumdb_test.stripe_webhook_audit USING btree (created_at);


--
-- Name: idx_stripe_webhook_audit_event_id; Type: INDEX; Schema: heliumdb_test; Owner: -
--

CREATE INDEX idx_stripe_webhook_audit_event_id ON heliumdb_test.stripe_webhook_audit USING btree (event_id);


--
-- Name: idx_transient_renders_created_at; Type: INDEX; Schema: heliumdb_test; Owner: -
--

CREATE INDEX idx_transient_renders_created_at ON heliumdb_test.transient_renders USING btree (created_at);


--
-- Name: idx_transient_renders_ip_hash_created_at; Type: INDEX; Schema: heliumdb_test; Owner: -
--

CREATE INDEX idx_transient_renders_ip_hash_created_at ON heliumdb_test.transient_renders USING btree (ip_hash, created_at);


--
-- Name: idx_transient_renders_user_id_created_at; Type: INDEX; Schema: heliumdb_test; Owner: -
--

CREATE INDEX idx_transient_renders_user_id_created_at ON heliumdb_test.transient_renders USING btree (user_id, created_at);


--
-- Name: route_stat_events_recorded_at_idx; Type: INDEX; Schema: heliumdb_test; Owner: -
--

CREATE INDEX route_stat_events_recorded_at_idx ON heliumdb_test.route_stat_events USING btree (recorded_at);


--
-- Name: route_stat_events_route_key_recorded_at_idx; Type: INDEX; Schema: heliumdb_test; Owner: -
--

CREATE INDEX route_stat_events_route_key_recorded_at_idx ON heliumdb_test.route_stat_events USING btree (route_key, recorded_at);


--
-- Name: ufp_user_fact_unique; Type: INDEX; Schema: heliumdb_test; Owner: -
--

CREATE UNIQUE INDEX ufp_user_fact_unique ON heliumdb_test.user_fact_preferences USING btree (user_id, fact_id);


--
-- Name: ufp_user_id_idx; Type: INDEX; Schema: heliumdb_test; Owner: -
--

CREATE INDEX ufp_user_id_idx ON heliumdb_test.user_fact_preferences USING btree (user_id);


--
-- Name: ufp_user_seen_hero_idx; Type: INDEX; Schema: heliumdb_test; Owner: -
--

CREATE INDEX ufp_user_seen_hero_idx ON heliumdb_test.user_fact_preferences USING btree (user_id, last_seen_as_hero_at);


--
-- Name: user_gen_costs_user_created_idx; Type: INDEX; Schema: heliumdb_test; Owner: -
--

CREATE INDEX user_gen_costs_user_created_idx ON heliumdb_test.user_generation_costs USING btree (user_id, created_at);


--
-- Name: video_jobs_created_at_idx; Type: INDEX; Schema: heliumdb_test; Owner: -
--

CREATE INDEX video_jobs_created_at_idx ON heliumdb_test.video_jobs USING btree (created_at);


--
-- Name: video_jobs_fact_id_idx; Type: INDEX; Schema: heliumdb_test; Owner: -
--

CREATE INDEX video_jobs_fact_id_idx ON heliumdb_test.video_jobs USING btree (fact_id);


--
-- Name: video_jobs_ip_address_idx; Type: INDEX; Schema: heliumdb_test; Owner: -
--

CREATE INDEX video_jobs_ip_address_idx ON heliumdb_test.video_jobs USING btree (ip_address);


--
-- Name: video_jobs_user_id_idx; Type: INDEX; Schema: heliumdb_test; Owner: -
--

CREATE INDEX video_jobs_user_id_idx ON heliumdb_test.video_jobs USING btree (user_id);


--
-- Name: IDX_engines_kind_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_engines_kind_active" ON public.engines USING btree (kind, is_active);


--
-- Name: IDX_engines_kind_default; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_engines_kind_default" ON public.engines USING btree (kind, is_default);


--
-- Name: IDX_eoh_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_eoh_created_at" ON public.enrichment_override_history USING btree (created_at DESC NULLS LAST);


--
-- Name: IDX_eoh_fact_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_eoh_fact_id" ON public.enrichment_override_history USING btree (fact_id);


--
-- Name: IDX_erb_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_erb_created_at" ON public.engine_revision_bumps USING btree (created_at DESC NULLS LAST);


--
-- Name: IDX_evt_token_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_evt_token_hash" ON public.email_verification_tokens USING btree (token_hash);


--
-- Name: IDX_fev_fact_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_fev_fact_id" ON public.fact_enrichment_versions USING btree (fact_id);


--
-- Name: IDX_fev_fact_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_fev_fact_status" ON public.fact_enrichment_versions USING btree (fact_id, status);


--
-- Name: IDX_fteh_fact_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_fteh_fact_created" ON public.fact_text_edit_history USING btree (fact_id, created_at DESC NULLS LAST);


--
-- Name: IDX_ipa_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_ipa_created_at" ON public.image_prompt_attempts USING btree (created_at DESC NULLS LAST);


--
-- Name: IDX_ipa_fact_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_ipa_fact_id" ON public.image_prompt_attempts USING btree (fact_id);


--
-- Name: IDX_ipa_review_input_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_ipa_review_input_hash" ON public.image_prompt_attempts USING btree (review_id, review_render_input_hash);


--
-- Name: IDX_ipa_review_scenario_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_ipa_review_scenario_created" ON public.image_prompt_attempts USING btree (review_id, review_render_scenario_key, created_at DESC NULLS LAST);


--
-- Name: IDX_ipa_subject_render_mode; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_ipa_subject_render_mode" ON public.image_prompt_attempts USING btree (subject_render_mode);


--
-- Name: IDX_ipa_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_ipa_user_id" ON public.image_prompt_attempts USING btree (user_id);


--
-- Name: IDX_memes_artifact_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_memes_artifact_type" ON public.memes USING btree (artifact_type);


--
-- Name: IDX_memes_deleted_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_memes_deleted_at" ON public.memes USING btree (deleted_at) WHERE (deleted_at IS NULL);


--
-- Name: IDX_memes_heart_count; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_memes_heart_count" ON public.memes USING btree (heart_count);


--
-- Name: IDX_memes_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_memes_status" ON public.memes USING btree (status);


--
-- Name: IDX_ncmec_audit_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_ncmec_audit_created" ON public.ncmec_safety_audit_log USING btree (created_at DESC);


--
-- Name: IDX_ncmec_audit_report_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_ncmec_audit_report_created" ON public.ncmec_safety_audit_log USING btree (report_id, created_at DESC);


--
-- Name: IDX_ncmec_failed_unalerted; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_ncmec_failed_unalerted" ON public.ncmec_reports USING btree (id) WHERE (((submission_status)::text = 'failed'::text) AND (alert_notified_at IS NULL));


--
-- Name: IDX_ncmec_nonfinal; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_ncmec_nonfinal" ON public.ncmec_reports USING btree (submission_status, id) WHERE ((submission_status)::text = ANY ((ARRAY['pending'::character varying, 'in_progress'::character varying])::text[]));


--
-- Name: IDX_ncmec_status_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_ncmec_status_created" ON public.ncmec_reports USING btree (submission_status, created_at);


--
-- Name: IDX_oauth_pending_states_expires_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_oauth_pending_states_expires_at" ON public.oauth_pending_states USING btree (expires_at);


--
-- Name: IDX_prt_token_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_prt_token_hash" ON public.password_reset_tokens USING btree (token_hash);


--
-- Name: IDX_quarantined_live; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_quarantined_live" ON public.quarantined_memes USING btree (id) WHERE (deleted_at IS NULL);


--
-- Name: IDX_quarantined_source_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_quarantined_source_created" ON public.quarantined_memes USING btree (source, created_at DESC NULLS LAST);


--
-- Name: IDX_quarantined_user_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_quarantined_user_created" ON public.quarantined_memes USING btree (user_id, created_at DESC NULLS LAST);


--
-- Name: IDX_reactions_target; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_reactions_target" ON public.reactions USING btree (target_type, target_id);


--
-- Name: IDX_reactions_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_reactions_user" ON public.reactions USING btree (user_id);


--
-- Name: IDX_reference_research_cache_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_reference_research_cache_created_at" ON public.reference_research_cache USING btree (created_at DESC NULLS LAST);


--
-- Name: IDX_session_expire; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_session_expire" ON public.sessions USING btree (expire);


--
-- Name: IDX_session_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_session_user_id" ON public.sessions USING btree (user_id);


--
-- Name: IDX_uai_fact_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_uai_fact_id" ON public.user_ai_images USING btree (fact_id);


--
-- Name: IDX_uai_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_uai_user_id" ON public.user_ai_images USING btree (user_id);


--
-- Name: IDX_uim_arachnid_sha256; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_uim_arachnid_sha256" ON public.upload_image_metadata USING btree (arachnid_sha256_hex);


--
-- Name: IDX_uim_pulid_dedup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_uim_pulid_dedup" ON public.upload_image_metadata USING btree (user_id, fact_id, source_object_path, transform_params_hash) WHERE ((transform)::text = 'pulid'::text);


--
-- Name: IDX_uim_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_uim_user_id" ON public.upload_image_metadata USING btree (user_id);


--
-- Name: IDX_uim_user_transform_fact; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_uim_user_transform_fact" ON public.upload_image_metadata USING btree (user_id, transform, fact_id);


--
-- Name: UQ_fev_fact_version_no; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "UQ_fev_fact_version_no" ON public.fact_enrichment_versions USING btree (fact_id, version_no);


--
-- Name: UQ_fev_one_candidate_per_fact; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "UQ_fev_one_candidate_per_fact" ON public.fact_enrichment_versions USING btree (fact_id) WHERE ((status)::text = 'candidate'::text);


--
-- Name: UQ_ncmec_reports_quarantine; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "UQ_ncmec_reports_quarantine" ON public.ncmec_reports USING btree (quarantine_id) WHERE (quarantine_id IS NOT NULL);


--
-- Name: UQ_reactions_user_target_type; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "UQ_reactions_user_target_type" ON public.reactions USING btree (user_id, target_type, target_id, reaction_type);


--
-- Name: async_jobs_dedupe_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX async_jobs_dedupe_idx ON public.async_jobs USING btree (queue, dedupe_key) WHERE ((dedupe_key IS NOT NULL) AND ((status)::text = ANY ((ARRAY['pending'::character varying, 'processing'::character varying])::text[])));


--
-- Name: async_jobs_pending_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX async_jobs_pending_idx ON public.async_jobs USING btree (queue, next_attempt_at) WHERE ((status)::text = 'pending'::text);


--
-- Name: async_jobs_status_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX async_jobs_status_created_idx ON public.async_jobs USING btree (queue, status, created_at DESC NULLS LAST);


--
-- Name: facts_adult_suitability_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX facts_adult_suitability_idx ON public.facts USING btree (adult_suitability);


--
-- Name: facts_parent_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX facts_parent_id_idx ON public.facts USING btree (parent_id);


--
-- Name: facts_primary_archetype_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX facts_primary_archetype_idx ON public.facts USING btree (primary_archetype);


--
-- Name: facts_wilson_score_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX facts_wilson_score_idx ON public.facts USING btree (wilson_score DESC NULLS LAST);


--
-- Name: idx_activity_feed_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_activity_feed_user ON public.activity_feed USING btree (user_id, created_at DESC NULLS LAST);


--
-- Name: idx_checkout_request_ledger_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_checkout_request_ledger_user_id ON public.stripe_checkout_request_ledger USING btree (user_id);


--
-- Name: idx_entitlement_source_disputes_open; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_entitlement_source_disputes_open ON public.entitlement_source_disputes USING btree (source_id) WHERE (NOT is_terminal);


--
-- Name: idx_entitlement_source_disputes_source_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_entitlement_source_disputes_source_id ON public.entitlement_source_disputes USING btree (source_id);


--
-- Name: idx_membership_entitlements_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_membership_entitlements_user_id ON public.membership_entitlements USING btree (user_id);


--
-- Name: idx_membership_history_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_membership_history_user_id ON public.membership_history USING btree (user_id);


--
-- Name: idx_membership_leases_expires_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_membership_leases_expires_at ON public.membership_leases USING btree (expires_at);


--
-- Name: idx_pending_reviews_approved_fact; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pending_reviews_approved_fact ON public.pending_reviews USING btree (approved_fact_id);


--
-- Name: idx_pending_reviews_parent_fact; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pending_reviews_parent_fact ON public.pending_reviews USING btree (parent_fact_id);


--
-- Name: idx_pending_reviews_staging_fact; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pending_reviews_staging_fact ON public.pending_reviews USING btree (staging_fact_id);


--
-- Name: idx_pending_reviews_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pending_reviews_status ON public.pending_reviews USING btree (status);


--
-- Name: idx_pending_reviews_submitted_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pending_reviews_submitted_by ON public.pending_reviews USING btree (submitted_by_id);


--
-- Name: idx_pending_reviews_workflow_stage; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pending_reviews_workflow_stage ON public.pending_reviews USING btree (workflow_stage);


--
-- Name: idx_rate_limit_counters_expires_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rate_limit_counters_expires_at ON public.rate_limit_counters USING btree (expires_at);


--
-- Name: idx_share_intents_meme_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_share_intents_meme_created ON public.share_intents USING btree (meme_id, created_at);


--
-- Name: idx_share_intents_platform_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_share_intents_platform_created ON public.share_intents USING btree (platform, created_at);


--
-- Name: idx_share_intents_user_platform_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_share_intents_user_platform_created ON public.share_intents USING btree (user_id, platform, created_at);


--
-- Name: idx_stripe_webhook_audit_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stripe_webhook_audit_created_at ON public.stripe_webhook_audit USING btree (created_at);


--
-- Name: idx_stripe_webhook_audit_event_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stripe_webhook_audit_event_id ON public.stripe_webhook_audit USING btree (event_id);


--
-- Name: idx_transient_renders_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_transient_renders_created_at ON public.transient_renders USING btree (created_at);


--
-- Name: idx_transient_renders_ip_hash_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_transient_renders_ip_hash_created_at ON public.transient_renders USING btree (ip_hash, created_at);


--
-- Name: idx_transient_renders_user_id_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_transient_renders_user_id_created_at ON public.transient_renders USING btree (user_id, created_at);


--
-- Name: tier_feature_permission_audit_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tier_feature_permission_audit_created_at_idx ON public.tier_feature_permission_audit USING btree (created_at);


--
-- Name: ufp_user_fact_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ufp_user_fact_unique ON public.user_fact_preferences USING btree (user_id, fact_id);


--
-- Name: ufp_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ufp_user_id_idx ON public.user_fact_preferences USING btree (user_id);


--
-- Name: ufp_user_seen_hero_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ufp_user_seen_hero_idx ON public.user_fact_preferences USING btree (user_id, last_seen_as_hero_at);


--
-- Name: uq_membership_entitlements_active_admin_grant; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_membership_entitlements_active_admin_grant ON public.membership_entitlements USING btree (user_id) WHERE (((source_type)::text = 'admin_grant'::text) AND ((lifecycle_status)::text = 'active'::text));


--
-- Name: uq_membership_entitlements_provider_ref; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_membership_entitlements_provider_ref ON public.membership_entitlements USING btree (source_type, provider_ref) WHERE (provider_ref IS NOT NULL);


--
-- Name: user_gen_costs_user_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX user_gen_costs_user_created_idx ON public.user_generation_costs USING btree (user_id, created_at);


--
-- Name: worker_lane_heartbeats_last_scheduled_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX worker_lane_heartbeats_last_scheduled_idx ON public.worker_lane_heartbeats USING btree (last_scheduled_at);


--
-- Name: active_entitlements_lookup_key_key; Type: INDEX; Schema: stripe; Owner: -
--

CREATE UNIQUE INDEX active_entitlements_lookup_key_key ON stripe.active_entitlements USING btree (lookup_key) WHERE (lookup_key IS NOT NULL);


--
-- Name: features_lookup_key_key; Type: INDEX; Schema: stripe; Owner: -
--

CREATE UNIQUE INDEX features_lookup_key_key ON stripe.features USING btree (lookup_key) WHERE (lookup_key IS NOT NULL);


--
-- Name: idx_accounts_api_key_hashes; Type: INDEX; Schema: stripe; Owner: -
--

CREATE INDEX idx_accounts_api_key_hashes ON stripe.accounts USING gin (api_key_hashes);


--
-- Name: idx_accounts_business_name; Type: INDEX; Schema: stripe; Owner: -
--

CREATE INDEX idx_accounts_business_name ON stripe.accounts USING btree (business_name);


--
-- Name: idx_sync_status_resource_account; Type: INDEX; Schema: stripe; Owner: -
--

CREATE INDEX idx_sync_status_resource_account ON stripe._sync_status USING btree (resource, account_id);


--
-- Name: stripe_active_entitlements_customer_idx; Type: INDEX; Schema: stripe; Owner: -
--

CREATE INDEX stripe_active_entitlements_customer_idx ON stripe.active_entitlements USING btree (customer);


--
-- Name: stripe_active_entitlements_feature_idx; Type: INDEX; Schema: stripe; Owner: -
--

CREATE INDEX stripe_active_entitlements_feature_idx ON stripe.active_entitlements USING btree (feature);


--
-- Name: stripe_checkout_session_line_items_price_idx; Type: INDEX; Schema: stripe; Owner: -
--

CREATE INDEX stripe_checkout_session_line_items_price_idx ON stripe.checkout_session_line_items USING btree (price);


--
-- Name: stripe_checkout_session_line_items_session_idx; Type: INDEX; Schema: stripe; Owner: -
--

CREATE INDEX stripe_checkout_session_line_items_session_idx ON stripe.checkout_session_line_items USING btree (checkout_session);


--
-- Name: stripe_checkout_sessions_customer_idx; Type: INDEX; Schema: stripe; Owner: -
--

CREATE INDEX stripe_checkout_sessions_customer_idx ON stripe.checkout_sessions USING btree (customer);


--
-- Name: stripe_checkout_sessions_invoice_idx; Type: INDEX; Schema: stripe; Owner: -
--

CREATE INDEX stripe_checkout_sessions_invoice_idx ON stripe.checkout_sessions USING btree (invoice);


--
-- Name: stripe_checkout_sessions_payment_intent_idx; Type: INDEX; Schema: stripe; Owner: -
--

CREATE INDEX stripe_checkout_sessions_payment_intent_idx ON stripe.checkout_sessions USING btree (payment_intent);


--
-- Name: stripe_checkout_sessions_subscription_idx; Type: INDEX; Schema: stripe; Owner: -
--

CREATE INDEX stripe_checkout_sessions_subscription_idx ON stripe.checkout_sessions USING btree (subscription);


--
-- Name: stripe_credit_notes_customer_idx; Type: INDEX; Schema: stripe; Owner: -
--

CREATE INDEX stripe_credit_notes_customer_idx ON stripe.credit_notes USING btree (customer);


--
-- Name: stripe_credit_notes_invoice_idx; Type: INDEX; Schema: stripe; Owner: -
--

CREATE INDEX stripe_credit_notes_invoice_idx ON stripe.credit_notes USING btree (invoice);


--
-- Name: stripe_dispute_created_idx; Type: INDEX; Schema: stripe; Owner: -
--

CREATE INDEX stripe_dispute_created_idx ON stripe.disputes USING btree (created);


--
-- Name: stripe_early_fraud_warnings_charge_idx; Type: INDEX; Schema: stripe; Owner: -
--

CREATE INDEX stripe_early_fraud_warnings_charge_idx ON stripe.early_fraud_warnings USING btree (charge);


--
-- Name: stripe_early_fraud_warnings_payment_intent_idx; Type: INDEX; Schema: stripe; Owner: -
--

CREATE INDEX stripe_early_fraud_warnings_payment_intent_idx ON stripe.early_fraud_warnings USING btree (payment_intent);


--
-- Name: stripe_invoices_customer_idx; Type: INDEX; Schema: stripe; Owner: -
--

CREATE INDEX stripe_invoices_customer_idx ON stripe.invoices USING btree (customer);


--
-- Name: stripe_invoices_subscription_idx; Type: INDEX; Schema: stripe; Owner: -
--

CREATE INDEX stripe_invoices_subscription_idx ON stripe.invoices USING btree (subscription);


--
-- Name: stripe_managed_webhooks_enabled_idx; Type: INDEX; Schema: stripe; Owner: -
--

CREATE INDEX stripe_managed_webhooks_enabled_idx ON stripe._managed_webhooks USING btree (enabled);


--
-- Name: stripe_managed_webhooks_status_idx; Type: INDEX; Schema: stripe; Owner: -
--

CREATE INDEX stripe_managed_webhooks_status_idx ON stripe._managed_webhooks USING btree (status);


--
-- Name: stripe_payment_intents_customer_idx; Type: INDEX; Schema: stripe; Owner: -
--

CREATE INDEX stripe_payment_intents_customer_idx ON stripe.payment_intents USING btree (customer);


--
-- Name: stripe_payment_intents_invoice_idx; Type: INDEX; Schema: stripe; Owner: -
--

CREATE INDEX stripe_payment_intents_invoice_idx ON stripe.payment_intents USING btree (invoice);


--
-- Name: stripe_payment_methods_customer_idx; Type: INDEX; Schema: stripe; Owner: -
--

CREATE INDEX stripe_payment_methods_customer_idx ON stripe.payment_methods USING btree (customer);


--
-- Name: stripe_refunds_charge_idx; Type: INDEX; Schema: stripe; Owner: -
--

CREATE INDEX stripe_refunds_charge_idx ON stripe.refunds USING btree (charge);


--
-- Name: stripe_refunds_payment_intent_idx; Type: INDEX; Schema: stripe; Owner: -
--

CREATE INDEX stripe_refunds_payment_intent_idx ON stripe.refunds USING btree (payment_intent);


--
-- Name: stripe_reviews_charge_idx; Type: INDEX; Schema: stripe; Owner: -
--

CREATE INDEX stripe_reviews_charge_idx ON stripe.reviews USING btree (charge);


--
-- Name: stripe_reviews_payment_intent_idx; Type: INDEX; Schema: stripe; Owner: -
--

CREATE INDEX stripe_reviews_payment_intent_idx ON stripe.reviews USING btree (payment_intent);


--
-- Name: stripe_setup_intents_customer_idx; Type: INDEX; Schema: stripe; Owner: -
--

CREATE INDEX stripe_setup_intents_customer_idx ON stripe.setup_intents USING btree (customer);


--
-- Name: stripe_tax_ids_customer_idx; Type: INDEX; Schema: stripe; Owner: -
--

CREATE INDEX stripe_tax_ids_customer_idx ON stripe.tax_ids USING btree (customer);


--
-- Name: ncmec_reports ncmec_reports_link_quarantine_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ncmec_reports_link_quarantine_trg BEFORE INSERT ON public.ncmec_reports FOR EACH ROW EXECUTE FUNCTION public.ncmec_reports_link_quarantine();


--
-- Name: ncmec_safety_audit_log ncmec_safety_audit_log_no_mutate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ncmec_safety_audit_log_no_mutate BEFORE DELETE OR UPDATE ON public.ncmec_safety_audit_log FOR EACH ROW EXECUTE FUNCTION public.ncmec_safety_audit_log_append_only();

ALTER TABLE public.ncmec_safety_audit_log ENABLE ALWAYS TRIGGER ncmec_safety_audit_log_no_mutate;


--
-- Name: ncmec_safety_audit_log ncmec_safety_audit_log_no_truncate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ncmec_safety_audit_log_no_truncate BEFORE TRUNCATE ON public.ncmec_safety_audit_log FOR EACH STATEMENT EXECUTE FUNCTION public.ncmec_safety_audit_log_append_only();

ALTER TABLE public.ncmec_safety_audit_log ENABLE ALWAYS TRIGGER ncmec_safety_audit_log_no_truncate;


--
-- Name: entitlement_source_disputes trg_entitlement_source_disputes_guard_absorbing; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_entitlement_source_disputes_guard_absorbing BEFORE UPDATE ON public.entitlement_source_disputes FOR EACH ROW EXECUTE FUNCTION public.entitlement_source_disputes_guard_absorbing();


--
-- Name: membership_entitlements trg_membership_entitlements_guard_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_membership_entitlements_guard_immutable BEFORE UPDATE ON public.membership_entitlements FOR EACH ROW EXECUTE FUNCTION public.membership_entitlements_guard_immutable();


--
-- Name: _managed_webhooks handle_updated_at; Type: TRIGGER; Schema: stripe; Owner: -
--

CREATE TRIGGER handle_updated_at BEFORE UPDATE ON stripe._managed_webhooks FOR EACH ROW EXECUTE FUNCTION public.set_updated_at_metadata();


--
-- Name: _sync_status handle_updated_at; Type: TRIGGER; Schema: stripe; Owner: -
--

CREATE TRIGGER handle_updated_at BEFORE UPDATE ON stripe._sync_status FOR EACH ROW EXECUTE FUNCTION public.set_updated_at_metadata();


--
-- Name: accounts handle_updated_at; Type: TRIGGER; Schema: stripe; Owner: -
--

CREATE TRIGGER handle_updated_at BEFORE UPDATE ON stripe.accounts FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: active_entitlements handle_updated_at; Type: TRIGGER; Schema: stripe; Owner: -
--

CREATE TRIGGER handle_updated_at BEFORE UPDATE ON stripe.active_entitlements FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: charges handle_updated_at; Type: TRIGGER; Schema: stripe; Owner: -
--

CREATE TRIGGER handle_updated_at BEFORE UPDATE ON stripe.charges FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: checkout_session_line_items handle_updated_at; Type: TRIGGER; Schema: stripe; Owner: -
--

CREATE TRIGGER handle_updated_at BEFORE UPDATE ON stripe.checkout_session_line_items FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: checkout_sessions handle_updated_at; Type: TRIGGER; Schema: stripe; Owner: -
--

CREATE TRIGGER handle_updated_at BEFORE UPDATE ON stripe.checkout_sessions FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: coupons handle_updated_at; Type: TRIGGER; Schema: stripe; Owner: -
--

CREATE TRIGGER handle_updated_at BEFORE UPDATE ON stripe.coupons FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: customers handle_updated_at; Type: TRIGGER; Schema: stripe; Owner: -
--

CREATE TRIGGER handle_updated_at BEFORE UPDATE ON stripe.customers FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: disputes handle_updated_at; Type: TRIGGER; Schema: stripe; Owner: -
--

CREATE TRIGGER handle_updated_at BEFORE UPDATE ON stripe.disputes FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: early_fraud_warnings handle_updated_at; Type: TRIGGER; Schema: stripe; Owner: -
--

CREATE TRIGGER handle_updated_at BEFORE UPDATE ON stripe.early_fraud_warnings FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: events handle_updated_at; Type: TRIGGER; Schema: stripe; Owner: -
--

CREATE TRIGGER handle_updated_at BEFORE UPDATE ON stripe.events FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: features handle_updated_at; Type: TRIGGER; Schema: stripe; Owner: -
--

CREATE TRIGGER handle_updated_at BEFORE UPDATE ON stripe.features FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: invoices handle_updated_at; Type: TRIGGER; Schema: stripe; Owner: -
--

CREATE TRIGGER handle_updated_at BEFORE UPDATE ON stripe.invoices FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: payouts handle_updated_at; Type: TRIGGER; Schema: stripe; Owner: -
--

CREATE TRIGGER handle_updated_at BEFORE UPDATE ON stripe.payouts FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: plans handle_updated_at; Type: TRIGGER; Schema: stripe; Owner: -
--

CREATE TRIGGER handle_updated_at BEFORE UPDATE ON stripe.plans FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: prices handle_updated_at; Type: TRIGGER; Schema: stripe; Owner: -
--

CREATE TRIGGER handle_updated_at BEFORE UPDATE ON stripe.prices FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: products handle_updated_at; Type: TRIGGER; Schema: stripe; Owner: -
--

CREATE TRIGGER handle_updated_at BEFORE UPDATE ON stripe.products FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: refunds handle_updated_at; Type: TRIGGER; Schema: stripe; Owner: -
--

CREATE TRIGGER handle_updated_at BEFORE UPDATE ON stripe.refunds FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: reviews handle_updated_at; Type: TRIGGER; Schema: stripe; Owner: -
--

CREATE TRIGGER handle_updated_at BEFORE UPDATE ON stripe.reviews FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: subscriptions handle_updated_at; Type: TRIGGER; Schema: stripe; Owner: -
--

CREATE TRIGGER handle_updated_at BEFORE UPDATE ON stripe.subscriptions FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: activity_feed activity_feed_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.activity_feed
    ADD CONSTRAINT activity_feed_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES heliumdb_test.users(id);


--
-- Name: admin_config admin_config_updated_by_id_users_id_fk; Type: FK CONSTRAINT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.admin_config
    ADD CONSTRAINT admin_config_updated_by_id_users_id_fk FOREIGN KEY (updated_by_id) REFERENCES heliumdb_test.users(id) ON DELETE SET NULL;


--
-- Name: affiliate_clicks affiliate_clicks_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.affiliate_clicks
    ADD CONSTRAINT affiliate_clicks_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES heliumdb_test.users(id);


--
-- Name: comments comments_author_id_users_id_fk; Type: FK CONSTRAINT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.comments
    ADD CONSTRAINT comments_author_id_users_id_fk FOREIGN KEY (author_id) REFERENCES heliumdb_test.users(id);


--
-- Name: comments comments_fact_id_facts_id_fk; Type: FK CONSTRAINT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.comments
    ADD CONSTRAINT comments_fact_id_facts_id_fk FOREIGN KEY (fact_id) REFERENCES heliumdb_test.facts(id) ON DELETE CASCADE;


--
-- Name: email_verification_tokens email_verification_tokens_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.email_verification_tokens
    ADD CONSTRAINT email_verification_tokens_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES heliumdb_test.users(id) ON DELETE CASCADE;


--
-- Name: enrichment_override_history enrichment_override_history_fact_id_facts_id_fk; Type: FK CONSTRAINT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.enrichment_override_history
    ADD CONSTRAINT enrichment_override_history_fact_id_facts_id_fk FOREIGN KEY (fact_id) REFERENCES heliumdb_test.facts(id) ON DELETE CASCADE;


--
-- Name: enrichment_override_history enrichment_override_history_performed_by_users_id_fk; Type: FK CONSTRAINT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.enrichment_override_history
    ADD CONSTRAINT enrichment_override_history_performed_by_users_id_fk FOREIGN KEY (performed_by) REFERENCES heliumdb_test.users(id) ON DELETE SET NULL;


--
-- Name: external_links external_links_added_by_id_users_id_fk; Type: FK CONSTRAINT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.external_links
    ADD CONSTRAINT external_links_added_by_id_users_id_fk FOREIGN KEY (added_by_id) REFERENCES heliumdb_test.users(id);


--
-- Name: external_links external_links_fact_id_facts_id_fk; Type: FK CONSTRAINT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.external_links
    ADD CONSTRAINT external_links_fact_id_facts_id_fk FOREIGN KEY (fact_id) REFERENCES heliumdb_test.facts(id) ON DELETE CASCADE;


--
-- Name: fact_hashtags fact_hashtags_fact_id_facts_id_fk; Type: FK CONSTRAINT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.fact_hashtags
    ADD CONSTRAINT fact_hashtags_fact_id_facts_id_fk FOREIGN KEY (fact_id) REFERENCES heliumdb_test.facts(id) ON DELETE CASCADE;


--
-- Name: fact_hashtags fact_hashtags_hashtag_id_hashtags_id_fk; Type: FK CONSTRAINT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.fact_hashtags
    ADD CONSTRAINT fact_hashtags_hashtag_id_hashtags_id_fk FOREIGN KEY (hashtag_id) REFERENCES heliumdb_test.hashtags(id) ON DELETE CASCADE;


--
-- Name: facts facts_submitted_by_id_users_id_fk; Type: FK CONSTRAINT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.facts
    ADD CONSTRAINT facts_submitted_by_id_users_id_fk FOREIGN KEY (submitted_by_id) REFERENCES heliumdb_test.users(id);


--
-- Name: image_prompt_attempts image_prompt_attempts_fact_id_facts_id_fk; Type: FK CONSTRAINT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.image_prompt_attempts
    ADD CONSTRAINT image_prompt_attempts_fact_id_facts_id_fk FOREIGN KEY (fact_id) REFERENCES heliumdb_test.facts(id) ON DELETE CASCADE;


--
-- Name: image_prompt_attempts image_prompt_attempts_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.image_prompt_attempts
    ADD CONSTRAINT image_prompt_attempts_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES heliumdb_test.users(id) ON DELETE SET NULL;


--
-- Name: lifetime_entitlements lifetime_entitlements_granted_by_admin_id_users_id_fk; Type: FK CONSTRAINT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.lifetime_entitlements
    ADD CONSTRAINT lifetime_entitlements_granted_by_admin_id_users_id_fk FOREIGN KEY (granted_by_admin_id) REFERENCES heliumdb_test.users(id);


--
-- Name: lifetime_entitlements lifetime_entitlements_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.lifetime_entitlements
    ADD CONSTRAINT lifetime_entitlements_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES heliumdb_test.users(id);


--
-- Name: membership_history membership_history_performed_by_admin_id_users_id_fk; Type: FK CONSTRAINT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.membership_history
    ADD CONSTRAINT membership_history_performed_by_admin_id_users_id_fk FOREIGN KEY (performed_by_admin_id) REFERENCES heliumdb_test.users(id);


--
-- Name: membership_history membership_history_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.membership_history
    ADD CONSTRAINT membership_history_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES heliumdb_test.users(id);


--
-- Name: memes memes_created_by_id_users_id_fk; Type: FK CONSTRAINT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.memes
    ADD CONSTRAINT memes_created_by_id_users_id_fk FOREIGN KEY (created_by_id) REFERENCES heliumdb_test.users(id);


--
-- Name: memes memes_fact_id_facts_id_fk; Type: FK CONSTRAINT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.memes
    ADD CONSTRAINT memes_fact_id_facts_id_fk FOREIGN KEY (fact_id) REFERENCES heliumdb_test.facts(id) ON DELETE CASCADE;


--
-- Name: ncmec_reports ncmec_reports_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.ncmec_reports
    ADD CONSTRAINT ncmec_reports_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES heliumdb_test.users(id) ON DELETE SET NULL;


--
-- Name: oauth_pending_states oauth_pending_states_link_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.oauth_pending_states
    ADD CONSTRAINT oauth_pending_states_link_user_id_users_id_fk FOREIGN KEY (link_user_id) REFERENCES heliumdb_test.users(id) ON DELETE CASCADE;


--
-- Name: password_reset_tokens password_reset_tokens_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.password_reset_tokens
    ADD CONSTRAINT password_reset_tokens_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES heliumdb_test.users(id) ON DELETE CASCADE;


--
-- Name: pending_reviews pending_reviews_approved_fact_id_facts_id_fk; Type: FK CONSTRAINT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.pending_reviews
    ADD CONSTRAINT pending_reviews_approved_fact_id_facts_id_fk FOREIGN KEY (approved_fact_id) REFERENCES heliumdb_test.facts(id) ON DELETE SET NULL;


--
-- Name: pending_reviews pending_reviews_matching_fact_id_facts_id_fk; Type: FK CONSTRAINT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.pending_reviews
    ADD CONSTRAINT pending_reviews_matching_fact_id_facts_id_fk FOREIGN KEY (matching_fact_id) REFERENCES heliumdb_test.facts(id) ON DELETE SET NULL;


--
-- Name: pending_reviews pending_reviews_production_rejected_by_id_users_id_fk; Type: FK CONSTRAINT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.pending_reviews
    ADD CONSTRAINT pending_reviews_production_rejected_by_id_users_id_fk FOREIGN KEY (production_rejected_by_id) REFERENCES heliumdb_test.users(id);


--
-- Name: pending_reviews pending_reviews_reviewed_by_id_users_id_fk; Type: FK CONSTRAINT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.pending_reviews
    ADD CONSTRAINT pending_reviews_reviewed_by_id_users_id_fk FOREIGN KEY (reviewed_by_id) REFERENCES heliumdb_test.users(id);


--
-- Name: pending_reviews pending_reviews_staging_fact_id_facts_id_fk; Type: FK CONSTRAINT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.pending_reviews
    ADD CONSTRAINT pending_reviews_staging_fact_id_facts_id_fk FOREIGN KEY (staging_fact_id) REFERENCES heliumdb_test.facts(id) ON DELETE SET NULL;


--
-- Name: pending_reviews pending_reviews_submitted_by_id_users_id_fk; Type: FK CONSTRAINT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.pending_reviews
    ADD CONSTRAINT pending_reviews_submitted_by_id_users_id_fk FOREIGN KEY (submitted_by_id) REFERENCES heliumdb_test.users(id);


--
-- Name: quarantined_memes quarantined_memes_meme_id_memes_id_fk; Type: FK CONSTRAINT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.quarantined_memes
    ADD CONSTRAINT quarantined_memes_meme_id_memes_id_fk FOREIGN KEY (meme_id) REFERENCES heliumdb_test.memes(id) ON DELETE SET NULL;


--
-- Name: quarantined_memes quarantined_memes_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.quarantined_memes
    ADD CONSTRAINT quarantined_memes_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES heliumdb_test.users(id) ON DELETE SET NULL;


--
-- Name: ratings ratings_fact_id_facts_id_fk; Type: FK CONSTRAINT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.ratings
    ADD CONSTRAINT ratings_fact_id_facts_id_fk FOREIGN KEY (fact_id) REFERENCES heliumdb_test.facts(id) ON DELETE CASCADE;


--
-- Name: ratings ratings_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.ratings
    ADD CONSTRAINT ratings_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES heliumdb_test.users(id) ON DELETE CASCADE;


--
-- Name: reactions reactions_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.reactions
    ADD CONSTRAINT reactions_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES heliumdb_test.users(id) ON DELETE CASCADE;


--
-- Name: search_history search_history_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.search_history
    ADD CONSTRAINT search_history_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES heliumdb_test.users(id) ON DELETE CASCADE;


--
-- Name: sessions sessions_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.sessions
    ADD CONSTRAINT sessions_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES heliumdb_test.users(id) ON DELETE CASCADE;


--
-- Name: share_intents share_intents_meme_id_memes_id_fk; Type: FK CONSTRAINT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.share_intents
    ADD CONSTRAINT share_intents_meme_id_memes_id_fk FOREIGN KEY (meme_id) REFERENCES heliumdb_test.memes(id) ON DELETE CASCADE;


--
-- Name: share_intents share_intents_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.share_intents
    ADD CONSTRAINT share_intents_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES heliumdb_test.users(id) ON DELETE CASCADE;


--
-- Name: stripe_checkout_request_ledger stripe_checkout_request_ledger_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.stripe_checkout_request_ledger
    ADD CONSTRAINT stripe_checkout_request_ledger_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES heliumdb_test.users(id);


--
-- Name: subscriptions subscriptions_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.subscriptions
    ADD CONSTRAINT subscriptions_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES heliumdb_test.users(id);


--
-- Name: tier_feature_permissions tier_feature_permissions_feature_key_feature_flags_key_fk; Type: FK CONSTRAINT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.tier_feature_permissions
    ADD CONSTRAINT tier_feature_permissions_feature_key_feature_flags_key_fk FOREIGN KEY (feature_key) REFERENCES heliumdb_test.feature_flags(key) ON DELETE CASCADE;


--
-- Name: transient_renders transient_renders_fact_id_facts_id_fk; Type: FK CONSTRAINT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.transient_renders
    ADD CONSTRAINT transient_renders_fact_id_facts_id_fk FOREIGN KEY (fact_id) REFERENCES heliumdb_test.facts(id) ON DELETE SET NULL;


--
-- Name: transient_renders transient_renders_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.transient_renders
    ADD CONSTRAINT transient_renders_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES heliumdb_test.users(id) ON DELETE SET NULL;


--
-- Name: upload_image_metadata upload_image_metadata_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.upload_image_metadata
    ADD CONSTRAINT upload_image_metadata_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES heliumdb_test.users(id) ON DELETE SET NULL;


--
-- Name: user_ai_images user_ai_images_fact_id_facts_id_fk; Type: FK CONSTRAINT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.user_ai_images
    ADD CONSTRAINT user_ai_images_fact_id_facts_id_fk FOREIGN KEY (fact_id) REFERENCES heliumdb_test.facts(id) ON DELETE CASCADE;


--
-- Name: user_ai_images user_ai_images_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.user_ai_images
    ADD CONSTRAINT user_ai_images_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES heliumdb_test.users(id) ON DELETE CASCADE;


--
-- Name: user_fact_preferences user_fact_preferences_fact_id_facts_id_fk; Type: FK CONSTRAINT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.user_fact_preferences
    ADD CONSTRAINT user_fact_preferences_fact_id_facts_id_fk FOREIGN KEY (fact_id) REFERENCES heliumdb_test.facts(id) ON DELETE CASCADE;


--
-- Name: user_fact_preferences user_fact_preferences_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.user_fact_preferences
    ADD CONSTRAINT user_fact_preferences_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES heliumdb_test.users(id) ON DELETE CASCADE;


--
-- Name: video_jobs video_jobs_fact_id_facts_id_fk; Type: FK CONSTRAINT; Schema: heliumdb_test; Owner: -
--

ALTER TABLE ONLY heliumdb_test.video_jobs
    ADD CONSTRAINT video_jobs_fact_id_facts_id_fk FOREIGN KEY (fact_id) REFERENCES heliumdb_test.facts(id) ON DELETE CASCADE;


--
-- Name: activity_feed activity_feed_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activity_feed
    ADD CONSTRAINT activity_feed_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: admin_config admin_config_updated_by_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_config
    ADD CONSTRAINT admin_config_updated_by_id_users_id_fk FOREIGN KEY (updated_by_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: comments comments_author_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.comments
    ADD CONSTRAINT comments_author_id_users_id_fk FOREIGN KEY (author_id) REFERENCES public.users(id);


--
-- Name: comments comments_fact_id_facts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.comments
    ADD CONSTRAINT comments_fact_id_facts_id_fk FOREIGN KEY (fact_id) REFERENCES public.facts(id) ON DELETE CASCADE;


--
-- Name: email_verification_tokens email_verification_tokens_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_verification_tokens
    ADD CONSTRAINT email_verification_tokens_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: engine_revision_bumps engine_revision_bumps_performed_by_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.engine_revision_bumps
    ADD CONSTRAINT engine_revision_bumps_performed_by_users_id_fk FOREIGN KEY (performed_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: enrichment_override_history enrichment_override_history_fact_id_facts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.enrichment_override_history
    ADD CONSTRAINT enrichment_override_history_fact_id_facts_id_fk FOREIGN KEY (fact_id) REFERENCES public.facts(id) ON DELETE CASCADE;


--
-- Name: enrichment_override_history enrichment_override_history_performed_by_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.enrichment_override_history
    ADD CONSTRAINT enrichment_override_history_performed_by_users_id_fk FOREIGN KEY (performed_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: entitlement_source_disputes entitlement_source_disputes_source_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entitlement_source_disputes
    ADD CONSTRAINT entitlement_source_disputes_source_id_fk FOREIGN KEY (source_id) REFERENCES public.membership_entitlements(id) ON DELETE CASCADE;


--
-- Name: eval_runs eval_runs_created_by_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.eval_runs
    ADD CONSTRAINT eval_runs_created_by_users_id_fk FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: external_links external_links_added_by_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.external_links
    ADD CONSTRAINT external_links_added_by_id_users_id_fk FOREIGN KEY (added_by_id) REFERENCES public.users(id);


--
-- Name: external_links external_links_fact_id_facts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.external_links
    ADD CONSTRAINT external_links_fact_id_facts_id_fk FOREIGN KEY (fact_id) REFERENCES public.facts(id) ON DELETE CASCADE;


--
-- Name: fact_enrichment_versions fact_enrichment_versions_created_by_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fact_enrichment_versions
    ADD CONSTRAINT fact_enrichment_versions_created_by_users_id_fk FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: fact_enrichment_versions fact_enrichment_versions_fact_id_facts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fact_enrichment_versions
    ADD CONSTRAINT fact_enrichment_versions_fact_id_facts_id_fk FOREIGN KEY (fact_id) REFERENCES public.facts(id) ON DELETE CASCADE;


--
-- Name: fact_enrichment_versions fact_enrichment_versions_source_review_id_pending_reviews_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fact_enrichment_versions
    ADD CONSTRAINT fact_enrichment_versions_source_review_id_pending_reviews_id_fk FOREIGN KEY (source_review_id) REFERENCES public.pending_reviews(id) ON DELETE SET NULL;


--
-- Name: fact_hashtags fact_hashtags_fact_id_facts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fact_hashtags
    ADD CONSTRAINT fact_hashtags_fact_id_facts_id_fk FOREIGN KEY (fact_id) REFERENCES public.facts(id) ON DELETE CASCADE;


--
-- Name: fact_hashtags fact_hashtags_hashtag_id_hashtags_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fact_hashtags
    ADD CONSTRAINT fact_hashtags_hashtag_id_hashtags_id_fk FOREIGN KEY (hashtag_id) REFERENCES public.hashtags(id) ON DELETE CASCADE;


--
-- Name: fact_text_edit_history fact_text_edit_history_fact_id_facts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fact_text_edit_history
    ADD CONSTRAINT fact_text_edit_history_fact_id_facts_id_fk FOREIGN KEY (fact_id) REFERENCES public.facts(id) ON DELETE CASCADE;


--
-- Name: fact_text_edit_history fact_text_edit_history_performed_by_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fact_text_edit_history
    ADD CONSTRAINT fact_text_edit_history_performed_by_users_id_fk FOREIGN KEY (performed_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: facts facts_submitted_by_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.facts
    ADD CONSTRAINT facts_submitted_by_id_users_id_fk FOREIGN KEY (submitted_by_id) REFERENCES public.users(id);


--
-- Name: image_prompt_attempts image_prompt_attempts_eval_run_id_eval_runs_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.image_prompt_attempts
    ADD CONSTRAINT image_prompt_attempts_eval_run_id_eval_runs_id_fk FOREIGN KEY (eval_run_id) REFERENCES public.eval_runs(id) ON DELETE SET NULL;


--
-- Name: image_prompt_attempts image_prompt_attempts_fact_id_facts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.image_prompt_attempts
    ADD CONSTRAINT image_prompt_attempts_fact_id_facts_id_fk FOREIGN KEY (fact_id) REFERENCES public.facts(id) ON DELETE CASCADE;


--
-- Name: image_prompt_attempts image_prompt_attempts_review_id_pending_reviews_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.image_prompt_attempts
    ADD CONSTRAINT image_prompt_attempts_review_id_pending_reviews_id_fk FOREIGN KEY (review_id) REFERENCES public.pending_reviews(id) ON DELETE SET NULL;


--
-- Name: image_prompt_attempts image_prompt_attempts_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.image_prompt_attempts
    ADD CONSTRAINT image_prompt_attempts_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: membership_entitlements membership_entitlements_granted_by_admin_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.membership_entitlements
    ADD CONSTRAINT membership_entitlements_granted_by_admin_id_users_id_fk FOREIGN KEY (granted_by_admin_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: membership_entitlements membership_entitlements_revoked_by_admin_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.membership_entitlements
    ADD CONSTRAINT membership_entitlements_revoked_by_admin_id_users_id_fk FOREIGN KEY (revoked_by_admin_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: membership_entitlements membership_entitlements_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.membership_entitlements
    ADD CONSTRAINT membership_entitlements_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: membership_history membership_history_performed_by_admin_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.membership_history
    ADD CONSTRAINT membership_history_performed_by_admin_id_users_id_fk FOREIGN KEY (performed_by_admin_id) REFERENCES public.users(id);


--
-- Name: membership_history membership_history_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.membership_history
    ADD CONSTRAINT membership_history_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: memes memes_created_by_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memes
    ADD CONSTRAINT memes_created_by_id_users_id_fk FOREIGN KEY (created_by_id) REFERENCES public.users(id);


--
-- Name: memes memes_fact_id_facts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memes
    ADD CONSTRAINT memes_fact_id_facts_id_fk FOREIGN KEY (fact_id) REFERENCES public.facts(id) ON DELETE CASCADE;


--
-- Name: ncmec_reports ncmec_reports_quarantine_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ncmec_reports
    ADD CONSTRAINT ncmec_reports_quarantine_id_fk FOREIGN KEY (quarantine_id) REFERENCES public.quarantined_memes(id) ON DELETE SET NULL;


--
-- Name: ncmec_reports ncmec_reports_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ncmec_reports
    ADD CONSTRAINT ncmec_reports_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: ncmec_safety_audit_log ncmec_safety_audit_log_report_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ncmec_safety_audit_log
    ADD CONSTRAINT ncmec_safety_audit_log_report_id_fk FOREIGN KEY (report_id) REFERENCES public.ncmec_reports(id) ON DELETE RESTRICT;


--
-- Name: oauth_pending_states oauth_pending_states_link_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_pending_states
    ADD CONSTRAINT oauth_pending_states_link_user_id_users_id_fk FOREIGN KEY (link_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: password_reset_tokens password_reset_tokens_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.password_reset_tokens
    ADD CONSTRAINT password_reset_tokens_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: pending_reviews pending_reviews_approved_fact_id_facts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pending_reviews
    ADD CONSTRAINT pending_reviews_approved_fact_id_facts_id_fk FOREIGN KEY (approved_fact_id) REFERENCES public.facts(id) ON DELETE SET NULL;


--
-- Name: pending_reviews pending_reviews_matching_fact_id_facts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pending_reviews
    ADD CONSTRAINT pending_reviews_matching_fact_id_facts_id_fk FOREIGN KEY (matching_fact_id) REFERENCES public.facts(id) ON DELETE SET NULL;


--
-- Name: pending_reviews pending_reviews_parent_fact_id_facts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pending_reviews
    ADD CONSTRAINT pending_reviews_parent_fact_id_facts_id_fk FOREIGN KEY (parent_fact_id) REFERENCES public.facts(id) ON DELETE SET NULL;


--
-- Name: pending_reviews pending_reviews_production_rejected_by_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pending_reviews
    ADD CONSTRAINT pending_reviews_production_rejected_by_id_users_id_fk FOREIGN KEY (production_rejected_by_id) REFERENCES public.users(id);


--
-- Name: pending_reviews pending_reviews_reviewed_by_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pending_reviews
    ADD CONSTRAINT pending_reviews_reviewed_by_id_users_id_fk FOREIGN KEY (reviewed_by_id) REFERENCES public.users(id);


--
-- Name: pending_reviews pending_reviews_staging_fact_id_facts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pending_reviews
    ADD CONSTRAINT pending_reviews_staging_fact_id_facts_id_fk FOREIGN KEY (staging_fact_id) REFERENCES public.facts(id) ON DELETE SET NULL;


--
-- Name: pending_reviews pending_reviews_submitted_by_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pending_reviews
    ADD CONSTRAINT pending_reviews_submitted_by_id_users_id_fk FOREIGN KEY (submitted_by_id) REFERENCES public.users(id);


--
-- Name: quarantined_memes quarantined_memes_meme_id_memes_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quarantined_memes
    ADD CONSTRAINT quarantined_memes_meme_id_memes_id_fk FOREIGN KEY (meme_id) REFERENCES public.memes(id) ON DELETE SET NULL;


--
-- Name: quarantined_memes quarantined_memes_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quarantined_memes
    ADD CONSTRAINT quarantined_memes_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: reactions reactions_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reactions
    ADD CONSTRAINT reactions_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: search_history search_history_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.search_history
    ADD CONSTRAINT search_history_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: sessions sessions_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: share_intents share_intents_meme_id_memes_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.share_intents
    ADD CONSTRAINT share_intents_meme_id_memes_id_fk FOREIGN KEY (meme_id) REFERENCES public.memes(id) ON DELETE CASCADE;


--
-- Name: share_intents share_intents_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.share_intents
    ADD CONSTRAINT share_intents_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: stripe_checkout_request_ledger stripe_checkout_request_ledger_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stripe_checkout_request_ledger
    ADD CONSTRAINT stripe_checkout_request_ledger_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: tier_feature_permission_audit tier_feature_permission_audit_actor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tier_feature_permission_audit
    ADD CONSTRAINT tier_feature_permission_audit_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: tier_feature_permissions tier_feature_permissions_feature_key_feature_flags_key_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tier_feature_permissions
    ADD CONSTRAINT tier_feature_permissions_feature_key_feature_flags_key_fk FOREIGN KEY (feature_key) REFERENCES public.feature_flags(key) ON DELETE CASCADE;


--
-- Name: transient_renders transient_renders_fact_id_facts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transient_renders
    ADD CONSTRAINT transient_renders_fact_id_facts_id_fk FOREIGN KEY (fact_id) REFERENCES public.facts(id) ON DELETE SET NULL;


--
-- Name: transient_renders transient_renders_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transient_renders
    ADD CONSTRAINT transient_renders_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: upload_image_metadata upload_image_metadata_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.upload_image_metadata
    ADD CONSTRAINT upload_image_metadata_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: user_ai_images user_ai_images_fact_id_facts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_ai_images
    ADD CONSTRAINT user_ai_images_fact_id_facts_id_fk FOREIGN KEY (fact_id) REFERENCES public.facts(id) ON DELETE CASCADE;


--
-- Name: user_ai_images user_ai_images_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_ai_images
    ADD CONSTRAINT user_ai_images_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_fact_preferences user_fact_preferences_fact_id_facts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_fact_preferences
    ADD CONSTRAINT user_fact_preferences_fact_id_facts_id_fk FOREIGN KEY (fact_id) REFERENCES public.facts(id) ON DELETE CASCADE;


--
-- Name: user_fact_preferences user_fact_preferences_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_fact_preferences
    ADD CONSTRAINT user_fact_preferences_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: active_entitlements fk_active_entitlements_account; Type: FK CONSTRAINT; Schema: stripe; Owner: -
--

ALTER TABLE ONLY stripe.active_entitlements
    ADD CONSTRAINT fk_active_entitlements_account FOREIGN KEY (_account_id) REFERENCES stripe.accounts(id);


--
-- Name: charges fk_charges_account; Type: FK CONSTRAINT; Schema: stripe; Owner: -
--

ALTER TABLE ONLY stripe.charges
    ADD CONSTRAINT fk_charges_account FOREIGN KEY (_account_id) REFERENCES stripe.accounts(id);


--
-- Name: checkout_session_line_items fk_checkout_session_line_items_account; Type: FK CONSTRAINT; Schema: stripe; Owner: -
--

ALTER TABLE ONLY stripe.checkout_session_line_items
    ADD CONSTRAINT fk_checkout_session_line_items_account FOREIGN KEY (_account_id) REFERENCES stripe.accounts(id);


--
-- Name: checkout_sessions fk_checkout_sessions_account; Type: FK CONSTRAINT; Schema: stripe; Owner: -
--

ALTER TABLE ONLY stripe.checkout_sessions
    ADD CONSTRAINT fk_checkout_sessions_account FOREIGN KEY (_account_id) REFERENCES stripe.accounts(id);


--
-- Name: credit_notes fk_credit_notes_account; Type: FK CONSTRAINT; Schema: stripe; Owner: -
--

ALTER TABLE ONLY stripe.credit_notes
    ADD CONSTRAINT fk_credit_notes_account FOREIGN KEY (_account_id) REFERENCES stripe.accounts(id);


--
-- Name: customers fk_customers_account; Type: FK CONSTRAINT; Schema: stripe; Owner: -
--

ALTER TABLE ONLY stripe.customers
    ADD CONSTRAINT fk_customers_account FOREIGN KEY (_account_id) REFERENCES stripe.accounts(id);


--
-- Name: disputes fk_disputes_account; Type: FK CONSTRAINT; Schema: stripe; Owner: -
--

ALTER TABLE ONLY stripe.disputes
    ADD CONSTRAINT fk_disputes_account FOREIGN KEY (_account_id) REFERENCES stripe.accounts(id);


--
-- Name: early_fraud_warnings fk_early_fraud_warnings_account; Type: FK CONSTRAINT; Schema: stripe; Owner: -
--

ALTER TABLE ONLY stripe.early_fraud_warnings
    ADD CONSTRAINT fk_early_fraud_warnings_account FOREIGN KEY (_account_id) REFERENCES stripe.accounts(id);


--
-- Name: features fk_features_account; Type: FK CONSTRAINT; Schema: stripe; Owner: -
--

ALTER TABLE ONLY stripe.features
    ADD CONSTRAINT fk_features_account FOREIGN KEY (_account_id) REFERENCES stripe.accounts(id);


--
-- Name: invoices fk_invoices_account; Type: FK CONSTRAINT; Schema: stripe; Owner: -
--

ALTER TABLE ONLY stripe.invoices
    ADD CONSTRAINT fk_invoices_account FOREIGN KEY (_account_id) REFERENCES stripe.accounts(id);


--
-- Name: _managed_webhooks fk_managed_webhooks_account; Type: FK CONSTRAINT; Schema: stripe; Owner: -
--

ALTER TABLE ONLY stripe._managed_webhooks
    ADD CONSTRAINT fk_managed_webhooks_account FOREIGN KEY (account_id) REFERENCES stripe.accounts(id);


--
-- Name: payment_intents fk_payment_intents_account; Type: FK CONSTRAINT; Schema: stripe; Owner: -
--

ALTER TABLE ONLY stripe.payment_intents
    ADD CONSTRAINT fk_payment_intents_account FOREIGN KEY (_account_id) REFERENCES stripe.accounts(id);


--
-- Name: payment_methods fk_payment_methods_account; Type: FK CONSTRAINT; Schema: stripe; Owner: -
--

ALTER TABLE ONLY stripe.payment_methods
    ADD CONSTRAINT fk_payment_methods_account FOREIGN KEY (_account_id) REFERENCES stripe.accounts(id);


--
-- Name: plans fk_plans_account; Type: FK CONSTRAINT; Schema: stripe; Owner: -
--

ALTER TABLE ONLY stripe.plans
    ADD CONSTRAINT fk_plans_account FOREIGN KEY (_account_id) REFERENCES stripe.accounts(id);


--
-- Name: prices fk_prices_account; Type: FK CONSTRAINT; Schema: stripe; Owner: -
--

ALTER TABLE ONLY stripe.prices
    ADD CONSTRAINT fk_prices_account FOREIGN KEY (_account_id) REFERENCES stripe.accounts(id);


--
-- Name: products fk_products_account; Type: FK CONSTRAINT; Schema: stripe; Owner: -
--

ALTER TABLE ONLY stripe.products
    ADD CONSTRAINT fk_products_account FOREIGN KEY (_account_id) REFERENCES stripe.accounts(id);


--
-- Name: refunds fk_refunds_account; Type: FK CONSTRAINT; Schema: stripe; Owner: -
--

ALTER TABLE ONLY stripe.refunds
    ADD CONSTRAINT fk_refunds_account FOREIGN KEY (_account_id) REFERENCES stripe.accounts(id);


--
-- Name: reviews fk_reviews_account; Type: FK CONSTRAINT; Schema: stripe; Owner: -
--

ALTER TABLE ONLY stripe.reviews
    ADD CONSTRAINT fk_reviews_account FOREIGN KEY (_account_id) REFERENCES stripe.accounts(id);


--
-- Name: setup_intents fk_setup_intents_account; Type: FK CONSTRAINT; Schema: stripe; Owner: -
--

ALTER TABLE ONLY stripe.setup_intents
    ADD CONSTRAINT fk_setup_intents_account FOREIGN KEY (_account_id) REFERENCES stripe.accounts(id);


--
-- Name: subscription_items fk_subscription_items_account; Type: FK CONSTRAINT; Schema: stripe; Owner: -
--

ALTER TABLE ONLY stripe.subscription_items
    ADD CONSTRAINT fk_subscription_items_account FOREIGN KEY (_account_id) REFERENCES stripe.accounts(id);


--
-- Name: subscription_schedules fk_subscription_schedules_account; Type: FK CONSTRAINT; Schema: stripe; Owner: -
--

ALTER TABLE ONLY stripe.subscription_schedules
    ADD CONSTRAINT fk_subscription_schedules_account FOREIGN KEY (_account_id) REFERENCES stripe.accounts(id);


--
-- Name: subscriptions fk_subscriptions_account; Type: FK CONSTRAINT; Schema: stripe; Owner: -
--

ALTER TABLE ONLY stripe.subscriptions
    ADD CONSTRAINT fk_subscriptions_account FOREIGN KEY (_account_id) REFERENCES stripe.accounts(id);


--
-- Name: _sync_status fk_sync_status_account; Type: FK CONSTRAINT; Schema: stripe; Owner: -
--

ALTER TABLE ONLY stripe._sync_status
    ADD CONSTRAINT fk_sync_status_account FOREIGN KEY (account_id) REFERENCES stripe.accounts(id);


--
-- Name: tax_ids fk_tax_ids_account; Type: FK CONSTRAINT; Schema: stripe; Owner: -
--

ALTER TABLE ONLY stripe.tax_ids
    ADD CONSTRAINT fk_tax_ids_account FOREIGN KEY (_account_id) REFERENCES stripe.accounts(id);


--
-- PostgreSQL database dump complete
--

\unrestrict w99xrfkmfhq7w7RFi4yJqIbeG3c8vQwbd2MQeqrn1BtUyS34BKGpXe2PHarAzYn

