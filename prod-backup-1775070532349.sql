--
-- PostgreSQL database dump
--

\restrict XN4GlrhASLELV4jTDcQfxeivzlWGBAmsQwCtstpubCCUuqUOqH1lKaJbccWIDLC

-- Dumped from database version 16.12 (0113957)
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

ALTER TABLE IF EXISTS ONLY public.subscriptions DROP CONSTRAINT IF EXISTS subscriptions_user_id_fkey;
ALTER TABLE IF EXISTS ONLY public.search_history DROP CONSTRAINT IF EXISTS search_history_user_id_users_id_fk;
ALTER TABLE IF EXISTS ONLY public.ratings DROP CONSTRAINT IF EXISTS ratings_user_id_users_id_fk;
ALTER TABLE IF EXISTS ONLY public.ratings DROP CONSTRAINT IF EXISTS ratings_fact_id_facts_id_fk;
ALTER TABLE IF EXISTS ONLY public.pending_reviews DROP CONSTRAINT IF EXISTS pending_reviews_submitted_by_id_fkey;
ALTER TABLE IF EXISTS ONLY public.pending_reviews DROP CONSTRAINT IF EXISTS pending_reviews_reviewed_by_id_fkey;
ALTER TABLE IF EXISTS ONLY public.pending_reviews DROP CONSTRAINT IF EXISTS pending_reviews_matching_fact_id_fkey;
ALTER TABLE IF EXISTS ONLY public.pending_reviews DROP CONSTRAINT IF EXISTS pending_reviews_approved_fact_id_fkey;
ALTER TABLE IF EXISTS ONLY public.password_reset_tokens DROP CONSTRAINT IF EXISTS password_reset_tokens_user_id_fkey;
ALTER TABLE IF EXISTS ONLY public.memes DROP CONSTRAINT IF EXISTS memes_fact_id_facts_id_fk;
ALTER TABLE IF EXISTS ONLY public.memes DROP CONSTRAINT IF EXISTS memes_created_by_id_users_id_fk;
ALTER TABLE IF EXISTS ONLY public.membership_history DROP CONSTRAINT IF EXISTS membership_history_user_id_fkey;
ALTER TABLE IF EXISTS ONLY public.lifetime_entitlements DROP CONSTRAINT IF EXISTS lifetime_entitlements_user_id_fkey;
ALTER TABLE IF EXISTS ONLY public.facts DROP CONSTRAINT IF EXISTS facts_submitted_by_id_users_id_fk;
ALTER TABLE IF EXISTS ONLY public.facts DROP CONSTRAINT IF EXISTS facts_parent_id_fkey;
ALTER TABLE IF EXISTS ONLY public.fact_hashtags DROP CONSTRAINT IF EXISTS fact_hashtags_hashtag_id_hashtags_id_fk;
ALTER TABLE IF EXISTS ONLY public.fact_hashtags DROP CONSTRAINT IF EXISTS fact_hashtags_fact_id_facts_id_fk;
ALTER TABLE IF EXISTS ONLY public.external_links DROP CONSTRAINT IF EXISTS external_links_fact_id_facts_id_fk;
ALTER TABLE IF EXISTS ONLY public.external_links DROP CONSTRAINT IF EXISTS external_links_added_by_id_users_id_fk;
ALTER TABLE IF EXISTS ONLY public.email_verification_tokens DROP CONSTRAINT IF EXISTS email_verification_tokens_user_id_fkey;
ALTER TABLE IF EXISTS ONLY public.comments DROP CONSTRAINT IF EXISTS comments_fact_id_facts_id_fk;
ALTER TABLE IF EXISTS ONLY public.comments DROP CONSTRAINT IF EXISTS comments_author_id_users_id_fk;
ALTER TABLE IF EXISTS ONLY public.affiliate_clicks DROP CONSTRAINT IF EXISTS affiliate_clicks_user_id_fkey;
ALTER TABLE IF EXISTS ONLY public.activity_feed DROP CONSTRAINT IF EXISTS activity_feed_user_id_fkey;
DROP INDEX IF EXISTS public.idx_pending_reviews_submitted_by;
DROP INDEX IF EXISTS public.idx_pending_reviews_status;
DROP INDEX IF EXISTS public.idx_membership_history_user_id;
DROP INDEX IF EXISTS public.idx_activity_feed_user;
DROP INDEX IF EXISTS public.facts_wilson_score_idx;
DROP INDEX IF EXISTS public.facts_parent_id_idx;
DROP INDEX IF EXISTS public."IDX_session_expire";
DROP INDEX IF EXISTS public."IDX_prt_token_hash";
DROP INDEX IF EXISTS public."IDX_evt_token_hash";
ALTER TABLE IF EXISTS ONLY public.users DROP CONSTRAINT IF EXISTS users_stripe_customer_id_key;
ALTER TABLE IF EXISTS ONLY public.users DROP CONSTRAINT IF EXISTS users_pkey;
ALTER TABLE IF EXISTS ONLY public.users DROP CONSTRAINT IF EXISTS users_email_unique;
ALTER TABLE IF EXISTS ONLY public.subscriptions DROP CONSTRAINT IF EXISTS subscriptions_stripe_subscription_id_key;
ALTER TABLE IF EXISTS ONLY public.subscriptions DROP CONSTRAINT IF EXISTS subscriptions_pkey;
ALTER TABLE IF EXISTS ONLY public.sessions DROP CONSTRAINT IF EXISTS sessions_pkey;
ALTER TABLE IF EXISTS ONLY public.search_history DROP CONSTRAINT IF EXISTS search_history_pkey;
ALTER TABLE IF EXISTS ONLY public.ratings DROP CONSTRAINT IF EXISTS ratings_fact_id_user_id_unique;
ALTER TABLE IF EXISTS ONLY public.pending_reviews DROP CONSTRAINT IF EXISTS pending_reviews_pkey;
ALTER TABLE IF EXISTS ONLY public.password_reset_tokens DROP CONSTRAINT IF EXISTS password_reset_tokens_pkey;
ALTER TABLE IF EXISTS ONLY public.memes DROP CONSTRAINT IF EXISTS memes_pkey;
ALTER TABLE IF EXISTS ONLY public.memes DROP CONSTRAINT IF EXISTS memes_permalink_slug_unique;
ALTER TABLE IF EXISTS ONLY public.membership_history DROP CONSTRAINT IF EXISTS membership_history_pkey;
ALTER TABLE IF EXISTS ONLY public.lifetime_entitlements DROP CONSTRAINT IF EXISTS lifetime_entitlements_stripe_payment_intent_id_key;
ALTER TABLE IF EXISTS ONLY public.lifetime_entitlements DROP CONSTRAINT IF EXISTS lifetime_entitlements_pkey;
ALTER TABLE IF EXISTS ONLY public.hashtags DROP CONSTRAINT IF EXISTS hashtags_pkey;
ALTER TABLE IF EXISTS ONLY public.hashtags DROP CONSTRAINT IF EXISTS hashtags_name_unique;
ALTER TABLE IF EXISTS ONLY public.facts DROP CONSTRAINT IF EXISTS facts_pkey;
ALTER TABLE IF EXISTS ONLY public.fact_hashtags DROP CONSTRAINT IF EXISTS fact_hashtags_fact_id_hashtag_id_unique;
ALTER TABLE IF EXISTS ONLY public.external_links DROP CONSTRAINT IF EXISTS external_links_pkey;
ALTER TABLE IF EXISTS ONLY public.email_verification_tokens DROP CONSTRAINT IF EXISTS email_verification_tokens_pkey;
ALTER TABLE IF EXISTS ONLY public.comments DROP CONSTRAINT IF EXISTS comments_pkey;
ALTER TABLE IF EXISTS ONLY public.affiliate_clicks DROP CONSTRAINT IF EXISTS affiliate_clicks_pkey;
ALTER TABLE IF EXISTS ONLY public.activity_feed DROP CONSTRAINT IF EXISTS activity_feed_pkey;
ALTER TABLE IF EXISTS public.search_history ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.pending_reviews ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.password_reset_tokens ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.memes ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.hashtags ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.facts ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.external_links ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.email_verification_tokens ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.comments ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.affiliate_clicks ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.activity_feed ALTER COLUMN id DROP DEFAULT;
DROP TABLE IF EXISTS public.users;
DROP TABLE IF EXISTS public.subscriptions;
DROP TABLE IF EXISTS public.sessions;
DROP SEQUENCE IF EXISTS public.search_history_id_seq;
DROP TABLE IF EXISTS public.search_history;
DROP TABLE IF EXISTS public.ratings;
DROP SEQUENCE IF EXISTS public.pending_reviews_id_seq;
DROP TABLE IF EXISTS public.pending_reviews;
DROP SEQUENCE IF EXISTS public.password_reset_tokens_id_seq;
DROP TABLE IF EXISTS public.password_reset_tokens;
DROP SEQUENCE IF EXISTS public.memes_id_seq;
DROP TABLE IF EXISTS public.memes;
DROP TABLE IF EXISTS public.membership_history;
DROP TABLE IF EXISTS public.lifetime_entitlements;
DROP SEQUENCE IF EXISTS public.hashtags_id_seq;
DROP TABLE IF EXISTS public.hashtags;
DROP SEQUENCE IF EXISTS public.facts_id_seq;
DROP TABLE IF EXISTS public.facts;
DROP TABLE IF EXISTS public.fact_hashtags;
DROP SEQUENCE IF EXISTS public.external_links_id_seq;
DROP TABLE IF EXISTS public.external_links;
DROP SEQUENCE IF EXISTS public.email_verification_tokens_id_seq;
DROP TABLE IF EXISTS public.email_verification_tokens;
DROP SEQUENCE IF EXISTS public.comments_id_seq;
DROP TABLE IF EXISTS public.comments;
DROP SEQUENCE IF EXISTS public.affiliate_clicks_id_seq;
DROP TABLE IF EXISTS public.affiliate_clicks;
DROP SEQUENCE IF EXISTS public.activity_feed_id_seq;
DROP TABLE IF EXISTS public.activity_feed;
DROP FUNCTION IF EXISTS public.set_updated_at_metadata();
DROP FUNCTION IF EXISTS public.set_updated_at();
DROP TYPE IF EXISTS public.review_status;
DROP TYPE IF EXISTS public.membership_tier;
DROP TYPE IF EXISTS public.affiliate_source_type;
DROP TYPE IF EXISTS public.affiliate_destination;
DROP TYPE IF EXISTS public.activity_type;
DROP EXTENSION IF EXISTS vector;
--
-- Name: vector; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;


--
-- Name: EXTENSION vector; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION vector IS 'vector data type and ivfflat and hnsw access methods';


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
    'vote_cast',
    'system_message'
);


--
-- Name: affiliate_destination; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.affiliate_destination AS ENUM (
    'zazzle',
    'cafepress'
);


--
-- Name: affiliate_source_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.affiliate_source_type AS ENUM (
    'fact',
    'meme'
);


--
-- Name: membership_tier; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.membership_tier AS ENUM (
    'free',
    'premium'
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
-- Name: affiliate_clicks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.affiliate_clicks (
    id integer NOT NULL,
    user_id character varying,
    source_type public.affiliate_source_type NOT NULL,
    source_id character varying NOT NULL,
    destination public.affiliate_destination NOT NULL,
    clicked_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: affiliate_clicks_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.affiliate_clicks_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: affiliate_clicks_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.affiliate_clicks_id_seq OWNED BY public.affiliate_clicks.id;


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
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL
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
-- Name: fact_hashtags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fact_hashtags (
    fact_id integer NOT NULL,
    hashtag_id integer NOT NULL
);


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
    is_active boolean DEFAULT true NOT NULL,
    canonical_text text
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
-- Name: lifetime_entitlements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.lifetime_entitlements (
    id integer NOT NULL,
    user_id character varying NOT NULL,
    stripe_payment_intent_id character varying NOT NULL,
    stripe_customer_id character varying NOT NULL,
    amount integer,
    currency character varying DEFAULT 'usd'::character varying,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: lifetime_entitlements_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.lifetime_entitlements ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.lifetime_entitlements_id_seq
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
    created_at timestamp with time zone DEFAULT now() NOT NULL
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
    created_at timestamp with time zone DEFAULT now() NOT NULL
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
    reason text
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
-- Name: ratings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ratings (
    fact_id integer NOT NULL,
    user_id character varying NOT NULL,
    rating character varying(10) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
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
    expire timestamp without time zone NOT NULL
);


--
-- Name: subscriptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.subscriptions (
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
-- Name: subscriptions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.subscriptions ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.subscriptions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


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
    membership_tier public.membership_tier DEFAULT 'free'::public.membership_tier NOT NULL,
    password_hash character varying,
    pronouns character varying(80) DEFAULT 'he/him'::character varying,
    is_active boolean DEFAULT true NOT NULL,
    display_name character varying,
    email_verified_at timestamp with time zone,
    pending_email character varying,
    avatar_style character varying(30) DEFAULT 'bottts'::character varying
);


--
-- Name: activity_feed id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activity_feed ALTER COLUMN id SET DEFAULT nextval('public.activity_feed_id_seq'::regclass);


--
-- Name: affiliate_clicks id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.affiliate_clicks ALTER COLUMN id SET DEFAULT nextval('public.affiliate_clicks_id_seq'::regclass);


--
-- Name: comments id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.comments ALTER COLUMN id SET DEFAULT nextval('public.comments_id_seq'::regclass);


--
-- Name: email_verification_tokens id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_verification_tokens ALTER COLUMN id SET DEFAULT nextval('public.email_verification_tokens_id_seq'::regclass);


--
-- Name: external_links id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.external_links ALTER COLUMN id SET DEFAULT nextval('public.external_links_id_seq'::regclass);


--
-- Name: facts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.facts ALTER COLUMN id SET DEFAULT nextval('public.facts_id_seq'::regclass);


--
-- Name: hashtags id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hashtags ALTER COLUMN id SET DEFAULT nextval('public.hashtags_id_seq'::regclass);


--
-- Name: memes id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memes ALTER COLUMN id SET DEFAULT nextval('public.memes_id_seq'::regclass);


--
-- Name: password_reset_tokens id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.password_reset_tokens ALTER COLUMN id SET DEFAULT nextval('public.password_reset_tokens_id_seq'::regclass);


--
-- Name: pending_reviews id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pending_reviews ALTER COLUMN id SET DEFAULT nextval('public.pending_reviews_id_seq'::regclass);


--
-- Name: search_history id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.search_history ALTER COLUMN id SET DEFAULT nextval('public.search_history_id_seq'::regclass);


--
-- Data for Name: activity_feed; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.activity_feed (id, user_id, action_type, message, metadata, read, created_at) FROM stdin;
\.


--
-- Data for Name: affiliate_clicks; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.affiliate_clicks (id, user_id, source_type, source_id, destination, clicked_at) FROM stdin;
1	6f2b1072-469b-47c8-9de0-0d5ebdaeb8eb	fact	26	cafepress	2026-04-01 02:40:49.513219+00
\.


--
-- Data for Name: comments; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.comments (id, fact_id, author_id, text, flagged, flag_reason, created_at, status) FROM stdin;
\.


--
-- Data for Name: email_verification_tokens; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.email_verification_tokens (id, user_id, token_hash, expires_at, used_at, created_at, pending_email) FROM stdin;
\.


--
-- Data for Name: external_links; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.external_links (id, fact_id, url, title, platform, added_by_id, created_at) FROM stdin;
1	26	https://youtu.be/kQmPMZeN7JQ?t=40&si=Y0fn98yKL9jmp5H2	\N	YouTube	6f2b1072-469b-47c8-9de0-0d5ebdaeb8eb	2026-04-01 02:37:56.591797+00
\.


--
-- Data for Name: fact_hashtags; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.fact_hashtags (fact_id, hashtag_id) FROM stdin;
1	1
1	2
1	3
2	1
2	4
2	5
3	6
3	2
3	7
4	1
4	2
4	5
5	2
5	3
5	8
6	9
6	1
6	2
7	1
7	5
7	10
8	2
8	11
8	10
9	12
9	2
9	3
9	10
10	9
10	2
10	10
11	1
11	10
12	2
12	13
12	11
13	1
13	2
13	14
14	9
14	3
14	11
15	1
15	2
15	10
16	15
17	16
17	17
18	16
19	14
20	4
21	17
21	14
22	1
23	1
24	4
24	17
25	15
25	17
26	9
26	2
26	17
26	7
27	1
27	17
28	12
28	17
29	14
\.


--
-- Data for Name: facts; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.facts (id, text, submitted_by_id, upvotes, downvotes, score, comment_count, created_at, updated_at, embedding, wilson_score, parent_id, use_case, has_pronouns, is_active, canonical_text) FROM stdin;
4	Chuck Norris counted to infinity — twice.	\N	0	0	0	0	2026-03-31 05:08:22.439891+00	2026-04-01 18:56:18.877+00	[0.025787354,-0.015220642,0.035614014,0.002904892,0.060272217,0.09716797,-0.03869629,0.022201538,-0.08929443,0.02583313,0.043518066,0.0015106201,-0.0052490234,0.0017566681,0.033477783,0.027877808,-0.07543945,0.012649536,-0.00049495697,0.036956787,-0.090148926,-0.0005097389,0.0619812,0.03262329,0.09124756,-0.020050049,0.06921387,0.009147644,0.08380127,-0.010757446,0.09033203,-0.028961182,-0.019760132,0.03253174,0.0030612946,-0.05206299,0.09454346,-0.01687622,-0.013458252,-0.030349731,-0.0151901245,-0.090148926,0.02822876,0.013702393,0.004512787,-0.016403198,-0.013916016,-0.08770752,0.041503906,0.029632568,0.001657486,-0.0256958,-0.027496338,0.08001709,0.044799805,0.011909485,-0.027053833,0.019470215,-0.023956299,-0.03866577,0.02330017,-0.0770874,0.017471313,-0.032226562,-0.022918701,0.020889282,0.011131287,-0.022781372,0.079833984,0.05368042,-0.08477783,0.03366089,-0.07513428,0.07672119,0.0715332,0.026657104,-0.023895264,0.013961792,-0.014335632,0.019744873,0.07128906,0.0056114197,-0.03604126,-0.057006836,0.08355713,0.08062744,0.044525146,-0.013298035,-0.010108948,-0.007217407,-0.045562744,-0.0022621155,-0.017211914,-0.064819336,0.03765869,-0.043640137,0.0871582,0.1071167,0.046417236,-0.015975952,0.0118637085,0.028137207,0.07513428,-0.006111145,-0.0051651,0.15966797,-0.060791016,0.0014829636,-0.060272217,-0.04043579,0.01725769,0.002073288,-0.013549805,-0.07873535,-0.018569946,0.07659912,-0.01928711,0.07885742,0.012557983,0.02810669,0.09844971,-0.013061523,0.06616211,-0.020065308,0.026794434,-0.0736084,-0.031982422,0.098083496,0.024383545,0.022064209,0.051940918,-0.035827637,0.0046920776,0.020507812,-0.05178833,-0.00844574,-0.07476807,-0.0501709,-0.0071907043,0.017166138,-0.01725769,-0.052734375,-0.016693115,-0.011604309,0.06542969,-0.008666992,-0.029312134,0.028915405,0.07739258,-0.070617676,0.0015954971,-0.005317688,-0.025283813,-0.023223877,-0.016494751,0.03515625,0.014656067,-0.00630188,0.041748047,0.11260986,-0.0057640076,0.05026245,-0.054534912,0.042144775,-0.018432617,0.097595215,0.01725769,-0.053222656,-0.07458496,-0.084350586,-0.0037269592,0.0042915344,0.06347656,-0.13305664,0.056915283,0.02116394,-0.06524658,-0.032226562,-0.0736084,0.039123535,-0.009315491,0.046783447,-0.008857727,0.005718231,0.007896423,0.032348633,0.052856445,-0.015129089,0.09112549,0.0670166,-0.017303467,0.06707764,0.031021118,0.05557251,-0.0115737915,-0.10662842,0.097595215,-0.14001465,-0.0309906,-0.060668945,-0.018478394,0.08526611,0.04751587,-0.021133423,0.04660034,0.025024414,0.04071045,0.042419434,-0.022613525,-0.029037476,0.087890625,0.0107040405,-0.04675293,-0.008430481,-0.062805176,-0.04827881,0.111083984,-0.019805908,-0.09197998,-0.019973755,-0.049957275,0.052215576,0.021987915,-0.014976501,0.08679199,0.046051025,0.044708252,0.06149292,0.02885437,0.09790039,-0.0006046295,0.05206299,-0.0052948,-0.09307861,0.0031108856,0.054534912,0.04989624,0.0028495789,-0.05429077,0.015975952,-0.061706543,-0.00945282,-0.011489868,-0.003004074,-0.07470703,-0.019622803,-0.050689697,0.036224365,0.02456665,-0.03062439,-0.013839722,0.03527832,0.01802063,0.0072746277,-0.08178711,-0.02848816,0.005207062,-0.05105591,0.13085938,0.05331421,-0.0011491776,-0.044403076,-0.16320801,-0.03466797,-0.10229492,0.07055664,0.0034332275,-0.042816162,0.035308838,-0.014434814,0.058776855,-0.0055618286,0.004459381,-0.043670654,-0.028762817,-0.060791016,0.006313324,-0.006084442,-0.0016012192,-0.033355713,0.0053749084,0.0061531067,0.017425537,-0.072631836,0.06359863,-0.09375,0.0158844,0.10424805,0.07043457,-0.15856934,0.04763794,0.0065612793,0.035980225,0.057159424,-0.061523438,-0.030761719,0.011528015,-0.002084732,0.019470215,-0.009185791,0.017059326,0.062316895,0.0059318542,0.0362854,-0.051116943,0.0914917,-0.034729004,0.03555298,0.12207031,0.04336548,0.026794434,0.060577393,-0.048187256,-0.050842285,0.0024051666,-0.06951904,-0.042663574,-0.014656067,0.019424438,-0.015174866,0.053833008,0.023483276,0.023086548,0.04168701,-0.016021729,0.10223389,0.07672119,0.020980835,0.028808594,-0.0041542053,-0.044525146,-0.027267456,-0.0062217712,-0.033233643,-0.032684326,0.018600464,-0.021392822,0.005344391,-0.047424316,-0.066345215,-0.0071792603,0.02470398,0.014770508,0.008049011,-0.06317139,-0.004524231,0.043060303,0.0005207062,-0.010871887,-0.015213013,-0.005706787,0.02507019,0.02986145,0.04473877,0.027069092,0.028442383,-0.02003479,0.022964478,0.014877319,0.062927246,-0.1161499,0.093444824,0.031982422,0.013145447,-0.070251465,-0.044891357,-0.064697266,-0.014923096,0.013633728,0.05014038,-0.03466797,0.101501465,0.045806885,-0.006198883,0.036315918,0.11651611,0.02104187,-0.014198303,0.05166626,-0.05142212,-0.041290283,0.08630371,0.066467285,0.029663086]	0	\N	\N	f	t	Chuck Norris counted to infinity — twice.
3	Death once had a near-Chuck-Norris experience.	\N	0	0	0	0	2026-03-31 05:08:22.184965+00	2026-04-01 18:56:22.877+00	[-0.019317627,-0.009712219,-0.059570312,0.021606445,-0.016311646,0.11303711,0.068481445,0.088012695,-0.058441162,0.0103302,0.05343628,-0.02458191,0.025985718,0.010643005,0.06213379,0.022216797,-0.011451721,-0.00026154518,-0.062805176,0.03781128,-0.06286621,0.08392334,0.09539795,0.02961731,0.035614014,-0.009857178,0.049865723,0.008857727,0.097229004,-0.015548706,0.06707764,-0.012931824,0.00074005127,0.0309906,-0.010971069,0.06726074,0.0463562,0.029815674,0.047973633,0.015823364,0.013587952,-0.07342529,0.037506104,0.12005615,0.010681152,-0.055236816,-0.01612854,-0.06500244,0.0032596588,0.017440796,-0.062194824,-0.023727417,0.020599365,0.074645996,-0.06427002,-0.010765076,0.017486572,-0.0061912537,-0.0024967194,-0.023422241,0.14208984,-0.1237793,0.06359863,0.067993164,0.013038635,-0.05987549,-0.03250122,-0.010169983,0.00024986267,0.059417725,0.0079193115,0.05871582,-0.07788086,0.056762695,0.09588623,0.02810669,-0.053375244,0.010116577,-0.023147583,0.013282776,0.010925293,-0.06097412,-0.013977051,-0.021987915,0.029205322,-0.016693115,-0.08325195,-0.03326416,-0.049468994,0.045776367,0.048950195,0.06021118,0.007575989,-0.07562256,0.11651611,0.032287598,0.02281189,0.06640625,0.058288574,0.015342712,0.010231018,0.04031372,0.025146484,0.05441284,0.06842041,0.027694702,-0.062286377,0.061950684,-0.054107666,0.043548584,-0.019958496,-0.086120605,-0.08441162,-0.019454956,-0.14990234,-0.0020828247,0.08526611,-0.005756378,0.024490356,0.0357666,0.029205322,0.016937256,-0.07696533,-0.10168457,0.012832642,-0.022750854,0.05090332,0.066223145,-0.0013799667,-0.11248779,0.07373047,-0.00093507767,-0.068603516,-0.08239746,-0.00058984756,0.037139893,-0.07183838,-0.12225342,-0.061065674,-0.058776855,-0.14489746,-0.047821045,0.04345703,-0.041809082,0.02003479,0.06317139,0.038269043,0.09210205,0.03768921,-0.017456055,0.007095337,-0.0015211105,-0.06488037,-0.05065918,-0.03338623,-0.0032958984,-0.037902832,0.009269714,-0.0046920776,-0.055023193,0.020858765,-0.034423828,-0.06518555,0.05090332,-0.026519775,0.006259918,0.033721924,0.016281128,-0.11016846,-0.05630493,-0.011940002,-0.007385254,-0.0021629333,-0.048950195,0.005306244,0.010948181,-0.06530762,-0.09576416,-0.05987549,0.00086069107,0.011917114,0.074157715,0.009963989,0.09503174,-0.028747559,0.047851562,0.019592285,0.008552551,0.025390625,-0.03579712,0.011009216,0.051940918,-0.0748291,0.019836426,-0.015533447,-0.08178711,0.050720215,-0.051361084,0.023864746,0.0024089813,0.02130127,0.0036144257,0.01586914,-0.044006348,0.073913574,-0.034057617,0.039916992,0.05670166,0.040222168,-0.09454346,0.09350586,0.023010254,0.004009247,-0.055389404,0.008270264,-0.03555298,0.028564453,0.04876709,-0.05041504,0.041870117,0.035003662,0.06921387,0.023773193,0.015609741,-0.0018825531,-0.012039185,-0.018066406,-0.02027893,0.10345459,0.09588623,-0.047821045,-0.03842163,-0.032684326,-0.091552734,-0.01586914,0.005558014,0.00868988,0.010971069,-0.025009155,0.04928589,-0.030914307,0.045715332,0.041168213,0.0056037903,-0.057373047,-0.027816772,-0.036743164,-0.040924072,0.038146973,-0.005947113,0.020324707,0.018875122,0.0949707,0.025650024,-0.016998291,-0.03640747,0.015403748,-0.07556152,0.058807373,0.0395813,0.049682617,0.07757568,-0.04034424,0.06213379,-0.1217041,0.0017356873,-0.005996704,-0.040893555,-0.010597229,0.05718994,0.0062446594,-0.024429321,0.042144775,0.033416748,-0.055908203,-0.08062744,0.06665039,0.024368286,0.01637268,0.076049805,-0.032043457,0.017303467,-0.08001709,-0.13708496,-0.013542175,-0.023956299,-0.00010818243,-0.039154053,0.040100098,-0.110961914,-0.03152466,-0.059692383,0.03768921,0.06137085,-0.019073486,-0.04925537,-0.0579834,-0.009117126,0.055603027,-0.015136719,0.09100342,0.055755615,0.035614014,0.078125,-0.024368286,0.0713501,0.006515503,-0.009399414,0.010528564,-0.02204895,0.009101868,0.09375,-0.0040397644,0.0597229,-0.0023288727,-0.027954102,-0.019546509,0.03390503,-0.007820129,0.028152466,0.016235352,0.025436401,-0.054473877,-0.0012693405,-0.025619507,0.0340271,0.099121094,0.038848877,0.062286377,-0.045440674,-0.06542969,-0.011947632,-0.05947876,0.057037354,0.090270996,-0.08886719,-0.067993164,0.055908203,0.05593872,-0.040100098,-0.021697998,0.07537842,-0.0046958923,0.023834229,-0.067993164,-0.007286072,-0.018203735,-0.04043579,-0.019424438,0.038238525,-0.044433594,-0.021057129,-0.017471313,0.06689453,0.015960693,0.00063562393,-0.064575195,0.07397461,0.038757324,0.045928955,-0.06939697,0.05984497,-0.0009841919,0.015823364,-0.0005540848,-0.0440979,0.004512787,-0.056762695,0.0027618408,0.049957275,-0.053588867,0.04006958,0.016052246,-0.008308411,-0.04345703,0.06964111,-0.001285553,0.006286621,0.05154419,-0.06262207,-0.04901123,-0.04623413,0.059173584,0.0031776428]	0	\N	\N	f	t	Death once had a near-Chuck-Norris experience.
7	Chuck Norris can hear sign language.	\N	0	0	0	0	2026-03-31 05:08:23.097623+00	2026-04-01 18:56:24.622+00	[-0.0015888214,0.103271484,-0.1352539,-0.010665894,-0.010368347,0.085754395,-0.033294678,0.018554688,-0.101623535,-0.07269287,-0.024108887,0.07763672,-0.0022945404,0.13952637,-0.031555176,0.006893158,-0.04916382,0.031707764,-0.025161743,-0.049346924,0.05923462,0.04827881,-0.010505676,0.018005371,0.13122559,-0.01285553,0.06982422,0.08312988,0.09106445,0.0670166,0.023208618,-0.049316406,-0.044677734,0.005332947,0.013717651,-0.07159424,0.035003662,-0.016220093,-0.064331055,-0.06427002,0.040008545,-0.03289795,0.016799927,-0.033599854,0.024414062,0.009841919,-0.018661499,-0.043029785,0.008544922,0.024658203,-0.028793335,0.0657959,-0.039886475,0.112854004,0.033111572,-0.027511597,-0.032104492,-0.020812988,0.0473938,-0.018310547,-0.02279663,-0.07104492,-0.05441284,-0.042816162,-0.07476807,-0.04776001,0.0056533813,-0.056243896,0.02130127,0.06726074,-0.022857666,-0.0129852295,-0.044525146,0.0713501,-0.0284729,0.08404541,-0.12310791,0.06329346,0.010025024,0.03817749,0.06341553,0.018066406,-0.040618896,-0.055664062,-0.010673523,0.020858765,-0.039398193,0.03451538,-0.03390503,0.002243042,0.026062012,-0.000995636,-0.038024902,-0.066223145,0.07055664,0.04397583,0.014564514,-0.03543091,0.07940674,-0.03579712,0.020355225,0.0008955002,0.07171631,-0.07659912,0.05734253,0.17138672,0.0019931793,-0.018722534,0.007331848,0.03640747,-0.025360107,-0.049865723,0.07537842,-0.04360962,-0.03729248,-0.05142212,-0.0065612793,-0.08190918,0.011459351,0.06365967,0.05819702,0.016082764,0.012268066,0.038604736,-0.010276794,-0.02532959,-0.08087158,0.05154419,-0.10864258,-0.056274414,-0.06842041,-0.031311035,0.06378174,-0.019805908,-0.046661377,0.0045928955,-0.08068848,-0.08538818,-0.054595947,0.09918213,0.010215759,-0.029754639,-0.010505676,0.036743164,-0.046569824,-0.056427002,-0.03829956,0.012176514,0.04711914,0.015602112,-0.0020809174,-0.0044898987,0.0050468445,-0.04208374,-0.06842041,0.028259277,0.0026130676,0.0058784485,0.010612488,0.066467285,0.04498291,0.0546875,-0.02305603,0.06500244,0.010826111,0.030517578,0.07836914,0.012794495,0.033477783,-0.006969452,-0.028579712,0.03353882,0.032470703,-0.08062744,0.1303711,-0.04888916,0.053100586,-0.028717041,-0.011955261,0.01096344,-0.042510986,0.07965088,0.027069092,-0.053710938,-0.02218628,0.04916382,0.0022659302,0.023117065,0.08874512,-0.015655518,-0.041107178,0.018096924,0.07019043,-0.0050315857,0.023025513,-0.050476074,0.09967041,-0.1138916,0.0026302338,-0.08782959,-0.026565552,0.04586792,-0.003610611,-0.085998535,-0.0047721863,-0.0028438568,0.024719238,0.051361084,0.04864502,-0.00012022257,0.04373169,-0.0013313293,-0.049224854,-0.0031433105,-0.036621094,0.032165527,0.061706543,-0.024490356,-0.07922363,-0.058013916,-0.001490593,0.011428833,0.048431396,0.021728516,-0.05154419,0.01737976,0.08099365,0.08538818,0.038085938,0.050109863,-0.0121536255,0.031082153,0.06591797,0.00034308434,0.015213013,0.05984497,-0.08288574,0.017959595,-0.0026607513,0.008178711,-0.012336731,-0.06451416,-0.005302429,0.0491333,-0.042175293,0.023239136,-0.07543945,-0.01626587,0.025268555,-0.029266357,0.004425049,0.07446289,0.0031776428,0.049926758,-0.05871582,0.032104492,-0.06213379,-0.12347412,0.0057296753,0.04458618,0.008598328,-0.053833008,-0.009361267,-0.08673096,-0.020629883,-0.039398193,-0.012046814,0.0015106201,-0.00096845627,0.06262207,0.038970947,-0.012771606,-0.004173279,0.08642578,-0.045288086,-0.029815674,0.064819336,-0.017791748,0.022857666,0.016174316,-0.07159424,0.07745361,0.0042304993,-0.052520752,-0.048339844,-0.05505371,-0.06402588,-0.05545044,0.023773193,-0.039215088,0.030380249,-0.027023315,0.02381897,0.033599854,-0.030319214,-0.0008163452,0.010482788,-0.0017414093,-0.01612854,0.003786087,-0.03086853,0.062042236,-0.042510986,0.046081543,-0.027618408,0.12231445,-0.040039062,-0.024520874,0.08947754,0.009666443,-0.036193848,0.0625,-0.025756836,-0.02015686,-0.06561279,-0.037384033,0.03390503,-0.0030136108,-0.009712219,-0.04196167,0.057403564,0.09259033,0.04562378,-0.025726318,0.007537842,0.09362793,0.091674805,0.04650879,0.054748535,0.029052734,-0.021820068,-0.052764893,-0.03488159,0.041992188,0.05960083,0.039794922,-0.09552002,-0.03579712,-0.0032100677,-0.055725098,-0.101501465,0.05014038,-0.04309082,0.04257202,-0.018936157,-0.02331543,-0.07122803,-0.012260437,-0.035614014,0.009941101,-0.044311523,0.019760132,-0.03326416,0.014503479,-0.0012559891,0.009941101,-0.068603516,-0.03111267,-0.039367676,0.055480957,-0.105041504,0.0435791,-0.030899048,-0.0066184998,0.02923584,-0.11273193,-0.09436035,-0.005554199,0.10357666,-0.021850586,-0.017364502,0.03555298,0.06048584,0.064331055,0.011413574,0.04711914,-0.009788513,-0.062561035,0.025772095,-0.06964111,-0.057495117,0.024307251,0.12182617,-0.037628174]	0	\N	\N	f	t	Chuck Norris can hear sign language.
8	Chuck Norris makes onions cry.	\N	0	0	0	0	2026-03-31 05:08:23.321705+00	2026-04-01 18:56:30.877+00	[-0.027664185,0.0071029663,-0.08538818,0.015197754,0.039031982,0.026046753,0.025344849,-0.0063209534,-0.08520508,-0.05340576,0.071899414,0.023925781,0.01852417,0.04925537,-0.011123657,0.006690979,0.019927979,0.034301758,-0.10839844,-0.0063934326,0.02708435,0.092163086,0.04623413,-0.009613037,0.115600586,0.0040397644,0.10003662,-0.010765076,0.049987793,-0.011199951,0.024780273,-0.06976318,-0.041107178,0.05532837,-0.017608643,-0.006832123,0.058807373,-0.052215576,0.0008292198,0.019592285,0.027038574,-0.05126953,0.021774292,-0.0073127747,0.0011796951,-0.072265625,-0.08135986,-0.025756836,-0.04660034,-0.038757324,-0.014083862,0.024536133,-0.02293396,0.026290894,-0.024993896,0.020690918,-0.05316162,-0.0121536255,0.01234436,-0.036376953,0.01109314,-0.15136719,-0.035217285,-0.004989624,-0.031982422,-0.015342712,0.0023937225,-0.033081055,0.117614746,0.024993896,0.0058403015,0.0044822693,-0.026473999,0.07183838,0.08105469,-0.0055160522,0.034057617,0.039916992,0.0022678375,0.018920898,0.072631836,-0.028182983,-0.015029907,-0.03363037,0.014892578,-0.0029144287,-0.078186035,0.025680542,-0.036468506,0.057769775,-0.088012695,0.07220459,-0.012413025,-0.07928467,0.04525757,0.07128906,0.05001831,0.06173706,-0.020202637,-0.054718018,-0.0034866333,-0.06817627,0.026153564,0.036010742,0.025421143,0.14990234,0.0070114136,-0.07165527,-0.060516357,0.07385254,-0.021514893,-0.030532837,0.004787445,-0.07312012,-0.024215698,-0.03137207,-0.013702393,0.055755615,-0.0027122498,-0.0025558472,0.08337402,0.04067993,-0.0037059784,0.04385376,-0.041809082,0.035339355,0.024475098,0.09698486,0.030929565,-0.07067871,0.015686035,-0.040649414,0.03237915,0.04852295,-0.037322998,0.065979004,-0.08178711,-0.002128601,0.007095337,0.074279785,-0.007549286,-0.023880005,-0.03326416,0.052124023,0.029846191,-0.024124146,-0.043945312,0.020126343,0.10736084,0.05596924,0.03967285,0.0064926147,-0.017456055,-0.06347656,-0.039978027,-0.00466156,0.051239014,0.014732361,-0.009284973,0.0057373047,0.049346924,0.029785156,-0.059753418,-0.021835327,-0.074157715,0.061553955,0.068115234,0.00592041,-0.015052795,-0.12011719,0.007820129,-0.056427002,0.046905518,-0.041229248,0.0027866364,0.021835327,-0.023452759,-0.03479004,-0.026443481,0.12670898,0.02255249,0.12756348,-0.004627228,-0.0748291,0.02444458,0.030548096,-0.030883789,0.02178955,0.008911133,0.033599854,-0.035003662,0.027130127,-0.040802002,-0.007671356,-0.011062622,-0.046966553,0.07293701,-0.12792969,-0.038330078,-0.0065574646,0.062561035,0.1484375,0.0022525787,-0.011268616,0.018417358,-0.016098022,0.057006836,0.0135650635,-0.03125,0.035491943,0.098083496,0.011024475,-0.013977051,0.035461426,-0.015457153,-0.020721436,0.034210205,0.029846191,-0.04699707,-0.022659302,-0.032836914,-0.019760132,0.08288574,-0.0057907104,0.07733154,0.07879639,0.056640625,-0.023971558,0.07763672,0.06939697,-0.020141602,0.0362854,-0.023864746,-0.050750732,0.00024223328,0.040130615,-0.035858154,-0.035980225,0.008003235,0.041809082,-0.015640259,-0.023498535,-0.012901306,-0.0078125,0.0010585785,0.02722168,-0.048797607,0.0076789856,0.04272461,-0.045074463,-0.026443481,0.120666504,0.042877197,0.027938843,-0.0569458,-0.08679199,0.005504608,-0.10821533,-0.003326416,0.09039307,0.005470276,0.021621704,-0.05078125,-0.031311035,-0.051605225,0.01171875,-0.0016422272,-0.02696228,0.061553955,0.009849548,0.09124756,0.00459671,0.07397461,-0.05987549,-0.08404541,-0.070373535,0.0440979,-0.0040664673,-0.03225708,0.03201294,-0.066223145,0.027130127,0.02960205,-0.018356323,-0.0029315948,-0.07550049,-0.04989624,-0.02003479,0.057678223,-0.083618164,0.002090454,-0.09832764,0.037231445,0.13757324,-0.105529785,-0.019592285,-0.04928589,0.103881836,0.026748657,-0.05899048,0.07678223,0.08758545,0.026672363,0.0028266907,-0.0063705444,0.044128418,-0.011444092,0.03338623,0.08984375,-0.027648926,-0.049621582,0.06311035,-0.037078857,-0.039093018,0.02218628,-0.005203247,-0.04257202,0.032836914,-0.0231781,-0.003414154,0.031433105,0.032226562,0.0036506653,0.059387207,-0.02180481,0.12939453,0.14550781,0.042663574,0.002565384,0.007507324,-0.0758667,-0.040374756,-0.020858765,-0.01852417,-0.022079468,0.026000977,-0.024291992,0.036468506,-0.011726379,-0.07489014,-0.04031372,-0.022506714,0.017242432,0.035308838,-0.06323242,-0.015380859,0.08544922,0.005493164,-0.061431885,-0.037384033,-0.008766174,0.10681152,-0.056427002,-0.02897644,0.059387207,0.06665039,-0.04888916,0.020080566,0.002632141,0.053894043,-0.08135986,0.019882202,0.017944336,-0.03302002,-0.010147095,-0.07305908,-0.06274414,-0.028045654,0.056549072,-0.008056641,-0.031799316,0.058441162,0.04888916,-0.02633667,0.050598145,0.13208008,0.014274597,-0.008804321,0.057281494,-0.0947876,-0.05230713,0.06500244,-0.007911682,-0.014892578]	0	\N	\N	f	t	Chuck Norris makes onions cry.
1	When Chuck Norris does pushups, he doesn't push himself up — he pushes the Earth down.	\N	0	0	0	0	2026-03-31 05:08:21.618639+00	2026-04-01 18:56:53.177+00	[-0.027023315,0.0062713623,0.03353882,0.050750732,0.15942383,0.101135254,0.013320923,0.080566406,-0.07470703,-0.03781128,-0.011940002,0.07476807,-0.061035156,-0.0056915283,0.062408447,0.01852417,-0.007041931,-0.10424805,-0.08508301,0.024353027,-0.012069702,0.046142578,0.06463623,0.028411865,0.07299805,-0.00016009808,0.1038208,0.05307007,0.053466797,0.084350586,-0.015289307,-0.02067566,-0.049194336,0.0039634705,0.08117676,-0.0035133362,0.007949829,0.0032691956,-0.023513794,0.044799805,0.04244995,-0.08538818,-0.019317627,0.035705566,-0.03829956,0.00047421455,-0.04864502,-0.07525635,0.05432129,0.052947998,-0.084350586,-0.01146698,0.00541687,0.0060310364,0.01864624,0.028747559,-0.037994385,0.025421143,-0.05432129,0.032409668,0.04937744,-0.07336426,0.044799805,0.050750732,-0.058776855,-0.006954193,0.025985718,-0.0016679764,0.02418518,0.05731201,-0.020065308,0.03829956,-0.03302002,0.107421875,0.063964844,-0.027496338,-0.016189575,0.0340271,0.018096924,0.033447266,0.042755127,0.0017786026,0.01461792,-0.05429077,0.011680603,-0.013763428,-0.024368286,0.012321472,-0.009399414,0.023147583,0.014587402,-0.058288574,-0.006164551,-0.001200676,0.005531311,0.022567749,0.08911133,0.10290527,0.062683105,-0.06915283,0.04119873,-0.05380249,0.046051025,-0.019439697,0.0007033348,0.119262695,-0.08306885,0.0062332153,-0.038330078,0.07543945,0.03488159,-0.06719971,-0.056884766,-0.029663086,-0.071899414,0.031799316,0.021972656,0.074401855,-0.08679199,0.012397766,0.09173584,0.009384155,0.01802063,-0.002456665,0.019973755,-0.023025513,-0.003955841,0.13952637,-0.062408447,-0.012184143,0.04623413,0.04736328,-0.005393982,0.0059814453,0.028060913,0.04083252,-0.105529785,-0.06008911,-0.058288574,0.02330017,-0.026046753,0.019638062,-0.077941895,0.013046265,0.05819702,-0.034576416,0.04837036,0.0053749084,0.06451416,0.03652954,-0.0076904297,0.011390686,-0.054107666,0.019058228,-0.013534546,-0.052856445,0.083618164,0.015731812,0.032104492,0.06518555,0.00060367584,0.002588272,-0.09631348,0.035705566,-0.025772095,0.09326172,0.014076233,-0.12207031,-0.04046631,-0.077819824,-0.050048828,-0.012054443,0.07409668,-0.009796143,0.037963867,0.042388916,0.009941101,-0.023147583,0.013053894,0.018920898,0.044708252,0.037994385,0.026779175,0.056640625,-0.06439209,0.09674072,0.007949829,0.14257812,0.024124146,0.0848999,-0.041778564,0.068603516,0.0010633469,0.014541626,-0.03387451,-0.07873535,0.07293701,-0.0793457,0.0121154785,-0.017715454,0.00018954277,0.09991455,0.060760498,-0.022659302,0.017807007,0.019058228,0.020950317,0.07684326,-0.036376953,0.047973633,0.062316895,0.07159424,-0.08392334,-0.006412506,-0.030441284,-0.036712646,0.05114746,0.014595032,-0.084228516,-0.01007843,-0.022354126,0.048553467,0.062408447,0.021102905,-0.011177063,0.00730896,0.11773682,0.0069007874,0.05441284,0.05987549,-0.025390625,0.094177246,0.02079773,-0.035217285,0.017578125,0.05871582,0.008483887,-0.03286743,-0.0362854,0.04434204,-0.05267334,-0.014663696,-0.012786865,-0.11071777,-0.059417725,0.03262329,-0.039855957,-0.02279663,0.01737976,0.027786255,0.07232666,0.034820557,-0.03479004,-0.020980835,-0.050842285,0.033966064,0.0058631897,-0.04788208,0.030349731,0.08526611,0.027252197,0.06628418,-0.024932861,-0.016937256,-0.09082031,0.09729004,0.009178162,-0.08325195,0.04788208,0.06161499,0.09710693,0.07006836,0.051116943,-0.04196167,-0.0065574646,-0.04699707,0.006641388,-0.0099487305,-0.028793335,-0.011306763,0.0022392273,0.01914978,0.038360596,-0.04815674,0.0024738312,-0.0501709,-0.017333984,0.08294678,-0.009246826,-0.095336914,0.020446777,-0.03353882,0.037353516,0.07800293,-0.06774902,-0.03353882,-0.0010147095,-0.019485474,0.03768921,0.00035715103,0.026687622,0.051818848,-0.04257202,0.050079346,0.01928711,-0.025558472,0.0692749,-0.06323242,0.08325195,0.0034236908,-0.04586792,0.111694336,0.0015087128,0.017822266,-0.008346558,0.001285553,0.012084961,0.0026283264,-0.038208008,-0.021820068,-0.025909424,0.08880615,0.016479492,-0.01651001,0.036132812,0.03213501,0.1418457,-0.03237915,-0.0026111603,0.06756592,-0.055786133,-0.05847168,-0.031677246,-0.023269653,0.08300781,0.013626099,-0.03237915,0.026428223,0.05557251,-0.08728027,0.007583618,0.05154419,0.070617676,0.043945312,-0.103759766,-0.040161133,0.001865387,-0.03640747,-0.021530151,0.0446167,0.08673096,0.06359863,-0.02885437,0.016189575,0.05819702,0.009010315,-0.107299805,0.020446777,0.014595032,-0.0115356445,-0.062408447,-0.029388428,0.005218506,0.026733398,-0.03387451,-0.005016327,-0.01689148,-0.0005931854,0.02859497,0.021102905,-0.021560669,0.06665039,0.06008911,0.004371643,0.002943039,0.057373047,0.027633667,0.006767273,0.061157227,-0.07727051,-0.075683594,0.05987549,0.06689453,0.023101807]	0	\N	\N	f	t	When Chuck Norris does pushups, he doesn't push himself up — he pushes the Earth down.
16	Chuck Norris can delete the recycle bin without right-clicking.	\N	0	0	0	0	2026-03-31 05:08:25.009665+00	2026-04-01 18:56:55.277+00	[0.030654907,0.107177734,-0.02999878,2.9683113e-05,0.018341064,0.0096588135,-0.027145386,0.12420654,-0.08660889,-0.029327393,0.063964844,0.05404663,0.03729248,0.14160156,-0.036865234,0.048736572,-0.032836914,-0.037200928,-0.06286621,0.052368164,0.003982544,0.099487305,0.06274414,-0.026641846,-0.0052337646,0.037261963,0.08892822,0.030410767,0.01651001,0.025939941,-0.0023727417,-0.039978027,-0.082458496,0.009506226,0.021896362,0.019348145,0.06402588,-0.07336426,-0.076171875,0.0060577393,-0.048217773,-0.07702637,0.018798828,0.03643799,0.086242676,0.0541687,-0.041503906,-0.03817749,0.035583496,0.024597168,-0.057739258,0.0024681091,0.01838684,-0.013420105,-0.030456543,-0.028625488,-0.005241394,-0.015037537,-0.031677246,0.0149383545,0.041900635,-0.036987305,-0.041137695,0.0023288727,-0.06451416,0.04269409,0.044189453,0.027496338,0.02319336,0.026016235,-0.1138916,-0.04449463,-0.0725708,0.061706543,0.012870789,0.013145447,0.013206482,0.012084961,-0.029037476,0.027786255,0.06726074,-0.017349243,0.0036888123,-0.04626465,-0.039855957,0.08239746,-0.03781128,0.060546875,-0.0067634583,-0.06695557,-0.03225708,0.046783447,0.011100769,-0.047546387,0.02911377,0.020858765,0.009918213,0.043823242,0.059448242,0.056030273,0.04727173,-0.039001465,0.05645752,-0.026748657,-0.01335144,0.10040283,-0.10040283,-0.005783081,-0.035003662,0.037078857,0.023223877,-0.13146973,-0.035736084,-0.027633667,-0.025939941,-0.03125,0.021774292,0.10101318,-0.014564514,0.00044441223,0.07165527,0.05831909,-0.016525269,-0.06707764,-0.033996582,-0.028823853,-0.035827637,-0.028167725,-0.011260986,-0.07702637,0.026245117,0.011497498,0.10620117,-0.046844482,0.057922363,0.049194336,-0.10772705,-0.005191803,-0.056427002,0.115478516,-0.028015137,-0.008277893,-0.07611084,0.023757935,-0.098083496,-0.053009033,0.009750366,0.043151855,0.00010162592,0.06542969,0.07165527,0.0021572113,0.029678345,-0.064819336,-0.06719971,0.037322998,0.07788086,0.04421997,-0.020812988,0.022003174,-0.034973145,0.014205933,-0.048217773,0.03677368,-0.016983032,0.06707764,0.09564209,0.032409668,-0.011688232,-0.011062622,0.020492554,0.014419556,0.04714966,-0.10632324,-0.012809753,0.018341064,0.026779175,0.03933716,0.03552246,0.053497314,-0.019622803,0.032989502,0.08880615,-0.0018749237,-0.03765869,-0.007686615,0.06011963,-0.015029907,-0.0680542,0.048431396,-0.005657196,0.050811768,-0.013046265,0.057037354,-0.05645752,-0.010444641,0.04144287,-0.07788086,-0.0020217896,-0.12927246,-0.039031982,0.13574219,-0.03375244,-0.061798096,-0.04559326,0.00018918514,0.027130127,-0.040740967,-0.09106445,-0.064575195,0.021057129,-0.026351929,-0.047973633,-0.0041923523,-0.03111267,-0.03161621,0.11627197,0.028274536,-0.015731812,-0.066223145,-0.022262573,-0.02861023,0.05203247,-0.024795532,0.013031006,0.020965576,-0.008598328,-0.0064048767,0.027175903,0.11193848,-0.070617676,0.068481445,-0.019454956,-0.05053711,0.0074157715,0.07244873,-0.08093262,-0.088012695,-0.006713867,0.056549072,-0.013671875,-0.068603516,-0.014480591,-0.099487305,-0.0803833,-0.01727295,-0.01576233,0.011001587,0.012428284,0.034057617,0.051330566,0.054473877,0.018661499,-0.017807007,-0.044891357,-0.028015137,-0.06713867,-0.026107788,0.05633545,0.014320374,0.06958008,-0.04397583,-0.02279663,-0.030807495,-0.05078125,0.02279663,0.04055786,-0.0087509155,-0.028015137,0.0011148453,0.087402344,0.0925293,-0.029464722,-0.06713867,-0.006969452,0.0031394958,0.023284912,-0.060943604,-0.04107666,0.0020580292,-0.09075928,0.011688232,0.023284912,-0.042816162,-0.01789856,-0.040924072,-0.09869385,0.06463623,0.06781006,-0.09661865,0.0071792603,-0.053100586,0.00020229816,0.041656494,-0.048828125,0.012649536,-0.010482788,-0.015281677,-0.008232117,-0.022125244,-0.008880615,0.023529053,0.014389038,0.008575439,-0.068481445,0.0016384125,-0.031677246,-0.046966553,0.030639648,0.020004272,-0.095825195,0.04257202,-0.011978149,-0.0496521,-0.053955078,-0.056671143,-0.0079193115,-0.09289551,0.028839111,-0.062408447,0.12042236,0.026641846,0.08105469,-0.031341553,0.01108551,0.09033203,0.05645752,0.099853516,0.086364746,0.042633057,-0.043029785,-0.0019216537,-0.0690918,0.0030536652,0.085510254,0.019454956,-0.038757324,0.04058838,-0.00365448,-0.07446289,0.022262573,0.022079468,0.000497818,0.044799805,-0.027770996,-0.010887146,0.004096985,-0.015457153,-0.009140015,0.012504578,0.0046806335,0.0362854,-0.0748291,0.0044822693,-0.013587952,-0.0113220215,-0.08337402,-0.026550293,-0.04815674,0.05038452,0.010147095,0.044158936,-0.025146484,-0.045074463,0.07220459,-0.008865356,-0.14331055,-0.03668213,0.032684326,0.07385254,0.015655518,0.015296936,0.019348145,-0.03378296,-0.016677856,0.027816772,0.028320312,-0.058654785,0.064819336,-0.13330078,-0.042633057,-0.016082764,0.08947754,-0.017562866]	0	\N	\N	f	t	Chuck Norris can delete the recycle bin without right-clicking.
14	Chuck Norris was once in a knife fight, and the knife lost.	\N	0	0	0	0	2026-03-31 05:08:24.617068+00	2026-04-01 18:56:56.777+00	[-0.025817871,0.10845947,-0.059936523,-0.04333496,0.078063965,0.09613037,0.021560669,0.11047363,-0.035888672,0.02053833,0.029464722,-0.012527466,0.05947876,0.046173096,0.053527832,0.06341553,-0.047332764,-0.0038547516,-0.12414551,0.017791748,-0.07470703,0.08929443,0.05380249,-0.05154419,0.035461426,0.017486572,0.10986328,-0.022018433,0.05050659,0.09515381,0.075927734,-0.022964478,-0.039520264,0.084106445,-0.049346924,0.028564453,0.0574646,-0.030258179,0.016143799,-0.011421204,-0.044403076,-0.099731445,0.02784729,0.047088623,0.080566406,-0.068115234,0.044128418,-0.037872314,-0.017074585,-0.061950684,-0.052124023,0.010345459,0.01625061,0.05709839,0.037200928,0.015510559,-0.029586792,-0.055755615,-0.040222168,0.015792847,0.021087646,-0.13903809,0.022460938,-0.02861023,-0.04272461,-0.07269287,0.0038909912,0.057525635,0.06549072,0.02243042,-0.006072998,0.030197144,-0.030136108,0.08843994,0.079711914,0.06689453,-0.007888794,0.02671814,0.054656982,0.063964844,0.023010254,-0.0009508133,-0.009895325,-0.020599365,-0.016952515,0.0041007996,-0.11834717,-0.0004503727,-0.0107040405,-0.01285553,-0.03753662,0.043395996,0.0075912476,-0.068237305,0.058044434,0.046691895,0.0024585724,0.09979248,0.0362854,0.016174316,-0.0012960434,0.038269043,0.007080078,0.02947998,-0.042633057,0.11212158,-0.08135986,-0.051239014,-0.004886627,0.06536865,0.010269165,-0.08898926,-0.01473999,0.0039482117,-0.13806152,-0.019317627,0.025177002,0.052825928,0.04284668,0.07989502,0.008522034,0.026672363,0.04244995,-0.035247803,-0.06359863,0.11895752,0.009346008,0.025466919,0.014984131,-0.085998535,0.031555176,-0.0029277802,-0.037231445,-0.018341064,-0.043426514,0.04626465,-0.13171387,-0.0023078918,-0.036956787,0.07672119,-0.018554688,-0.036224365,-0.02861023,-0.0061454773,-0.019897461,0.017181396,0.039245605,0.045440674,0.06536865,-0.017822266,0.0769043,0.011245728,-0.030838013,0.015991211,-0.07525635,0.012771606,0.005870819,0.004085541,-0.040008545,0.027145386,-0.0011482239,0.016540527,-0.07739258,0.04660034,2.8729439e-05,0.01876831,0.097473145,-0.016586304,-0.013420105,-0.05392456,0.0725708,-0.027999878,0.062805176,-0.07354736,-0.039031982,0.010177612,0.011741638,-0.07305908,-0.0435791,-0.008918762,-0.011161804,0.07086182,0.04034424,-0.00066900253,-0.071899414,0.022537231,0.01902771,0.00038194656,0.070007324,-0.0071525574,0.03756714,0.05493164,-0.10211182,-0.027191162,-0.09326172,-0.03286743,0.09442139,0.011154175,-0.010848999,0.018234253,-0.004386902,0.049041748,-0.08300781,0.04522705,0.056152344,0.009979248,-0.011772156,-0.010566711,-0.020080566,-0.016967773,0.059906006,0.037322998,0.027145386,-0.06842041,0.019226074,-0.05795288,0.07183838,0.055114746,-0.09039307,-0.015701294,0.047302246,-0.018188477,0.06726074,-0.005870819,0.020507812,0.004798889,0.032165527,-0.043792725,0.089904785,0.018005371,-0.020263672,0.060516357,0.020248413,-0.055877686,-0.021377563,0.019729614,-0.025436401,-0.05307007,-0.024429321,0.04647827,-0.054016113,-0.019424438,0.022842407,0.0519104,-0.040802002,-0.003648758,-0.008529663,0.07598877,-0.0047683716,-0.0098724365,0.055419922,0.052764893,0.047058105,0.042816162,0.008987427,0.023544312,0.007888794,-0.08111572,-0.0038337708,0.028305054,0.052337646,0.00944519,-0.013412476,-0.005344391,-0.113708496,0.04269409,-0.012702942,-0.038116455,0.059783936,-0.033721924,0.0703125,0.051361084,-0.028701782,0.016723633,-0.028015137,-0.12939453,0.027145386,-0.0064048767,0.037231445,0.050994873,-0.005340576,0.052886963,-0.019638062,-0.0791626,0.014480591,-0.00699234,-0.021636963,0.048858643,0.040161133,-0.06958008,0.006580353,-0.083496094,0.034362793,0.16992188,-0.05923462,-0.009101868,-0.10021973,5.453825e-05,0.019363403,-0.0071983337,0.027526855,-0.018966675,0.028182983,0.054992676,-0.0058288574,0.05117798,-0.006958008,-0.01576233,0.0018072128,0.020996094,-0.048614502,0.10083008,-0.031555176,-0.012893677,-0.023010254,0.016784668,0.009140015,0.021408081,-0.013061523,0.045684814,0.056243896,0.01360321,0.046691895,0.055877686,0.0110321045,0.095581055,0.09484863,-0.04309082,0.07141113,0.041992188,-0.041015625,-0.054748535,-0.0847168,-0.04071045,0.00484848,0.009490967,0.003293991,0.089538574,0.004425049,-0.09503174,-0.032562256,0.04196167,-0.013587952,0.050476074,-0.017959595,-0.031188965,0.079833984,0.0017871857,-0.029937744,-0.065979004,-0.034820557,0.030258179,-0.023284912,0.062408447,0.018081665,0.026824951,-0.093933105,0.035705566,0.068359375,0.018493652,-0.06109619,0.11590576,-0.03845215,-0.004470825,-0.03970337,-0.057556152,-0.037994385,-0.07116699,0.02746582,-0.01675415,-0.025970459,0.08569336,-0.053894043,0.045074463,0.028503418,0.09295654,0.017349243,0.016052246,0.043670654,-0.079956055,0.026550293,-0.008995056,0.0836792,-0.057800293]	0	\N	\N	f	t	Chuck Norris was once in a knife fight, and the knife lost.
13	Time waits for no man. Unless that man is Chuck Norris.	\N	0	0	0	0	2026-03-31 05:08:24.389519+00	2026-04-01 18:56:59.056+00	[0.0035247803,0.080200195,-0.024215698,0.0340271,0.010169983,0.04864502,0.013473511,0.02519226,-0.077941895,-0.05618286,0.02168274,0.09088135,-0.052520752,-0.013938904,0.07891846,-0.04776001,-0.038879395,-0.10021973,0.03451538,0.06542969,-0.08050537,-0.010734558,-0.02015686,0.0058059692,0.05114746,0.0317688,0.04586792,0.06347656,0.016860962,0.047607422,0.044067383,-0.024795532,-0.014335632,0.03967285,0.04421997,0.087524414,0.055511475,-0.015533447,-0.06463623,-0.022705078,0.0040664673,-0.11010742,0.042938232,-0.009742737,0.07409668,-0.02861023,-0.05166626,-0.0090789795,0.0087509155,0.038909912,-0.06732178,-0.014373779,-0.093322754,0.12548828,0.03677368,0.02432251,0.03552246,-0.005054474,0.10229492,0.014144897,0.038970947,-0.042785645,0.010681152,0.049072266,-0.07147217,-0.016662598,0.035858154,-0.0143585205,-0.022109985,0.017059326,-0.05014038,0.015357971,-0.03741455,0.080200195,0.06689453,0.076660156,-0.05606079,0.044311523,0.106933594,0.03314209,0.011940002,-0.04269409,0.0073394775,0.017578125,-0.06640625,0.06427002,-0.053100586,0.039764404,0.02720642,-0.010597229,0.0005764961,0.058044434,-0.0340271,-0.03463745,0.0034503937,0.016952515,0.029144287,0.07659912,0.011413574,-0.005695343,0.030792236,0.0060424805,0.05050659,0.06738281,0.019302368,0.07067871,-0.07330322,0.009178162,-0.13220215,0.009033203,0.01373291,-0.06561279,-0.045013428,0.03213501,-0.096191406,-0.0020256042,-0.012046814,0.053253174,0.053833008,0.07470703,0.08123779,0.03161621,-0.07220459,-0.036590576,0.02218628,0.032287598,-0.0026130676,0.03363037,0.0037899017,-0.020523071,0.0048828125,-0.035369873,0.008323669,-0.026794434,0.02558899,0.006668091,-0.08465576,-0.03289795,-0.103881836,0.023635864,-0.12841797,-0.04031372,-0.023651123,0.025238037,0.08154297,0.042663574,-0.047943115,0.0473938,0.05670166,-0.026031494,0.006313324,-0.019729614,-0.018753052,0.02267456,0.06585693,0.008766174,0.011955261,0.032165527,-0.024261475,0.084472656,-0.016326904,0.040893555,-0.08276367,0.042816162,0.041168213,0.013427734,0.0690918,-0.095214844,-0.072753906,-0.044952393,0.0680542,-0.05267334,0.010635376,-0.06173706,0.11981201,0.019424438,-0.050476074,0.010437012,-0.0152282715,0.055725098,0.05102539,0.051818848,0.042816162,0.011764526,0.024093628,0.032043457,-0.0871582,0.037902832,0.026046753,-0.01939392,-0.031097412,0.04626465,-0.030838013,0.028900146,-0.0335083,-0.015274048,0.02432251,-0.0881958,0.028671265,-0.05014038,0.027114868,-0.021072388,0.02192688,-0.06463623,0.082336426,-0.033355713,0.012016296,0.020187378,-0.03744507,-0.029312134,0.030975342,-0.052856445,-0.0069389343,-0.08532715,-0.016540527,-0.097595215,-0.016021729,0.024993896,-0.109191895,-0.045928955,-0.04397583,0.07171631,0.020477295,0.018005371,0.054840088,0.07110596,-0.0023994446,0.012710571,-0.07348633,0.12286377,-0.049438477,0.029037476,-0.052978516,-0.06951904,-0.008735657,-7.05719e-05,-0.035583496,-0.07171631,-0.01776123,0.09039307,-0.050964355,-0.033599854,-0.01184082,0.015197754,-0.09484863,-0.053253174,-0.020858765,-0.034576416,0.020812988,-0.009063721,0.043518066,-0.043518066,0.022506714,-0.04232788,-0.015319824,0.034942627,0.0062561035,0.0029964447,0.07696533,0.0904541,0.04043579,-0.01626587,0.017700195,0.01927185,-0.016220093,0.055419922,0.05279541,-0.12902832,0.12182617,0.03466797,0.15771484,-0.0025997162,-0.013442993,-0.07800293,-0.072753906,-0.04763794,0.077941895,-0.021972656,-0.024459839,0.037231445,-0.06677246,0.012756348,0.028045654,-0.077819824,0.017425537,-0.034942627,0.094177246,0.09954834,0.047973633,-0.066345215,-0.017929077,-0.04345703,0.02456665,0.12207031,-0.0335083,-0.050720215,-0.03253174,0.0052986145,0.0006260872,0.0053977966,0.037872314,0.006111145,-0.014961243,0.044036865,-0.014656067,0.08605957,-0.01838684,-0.04336548,0.0637207,0.0680542,-0.061706543,0.08270264,0.00793457,-0.04397583,-0.077697754,-0.040496826,0.014717102,-0.0038471222,0.03982544,-0.07739258,-0.0015001297,0.027511597,-0.0064430237,0.06713867,-0.009857178,0.0158844,0.1496582,-0.030334473,0.040985107,0.0020484924,-0.1171875,-0.034729004,-0.059387207,0.030960083,0.02243042,-0.017333984,-0.019592285,0.003353119,0.023254395,-0.025344849,-0.027999878,-0.012504578,-0.04876709,0.059753418,-0.036590576,-0.01675415,0.01586914,-0.022659302,-0.022338867,-0.044525146,-0.015594482,0.044952393,-0.041870117,-0.009422302,-0.010986328,0.014678955,0.03704834,0.03781128,-0.07525635,0.055725098,-0.08508301,-0.035217285,-0.031921387,0.016952515,-0.0715332,-0.05291748,-0.00018632412,-0.039855957,-0.013832092,0.027069092,-0.01889038,0.003112793,0.058807373,-0.020751953,-0.008979797,0.014045715,-0.040405273,0.04336548,0.043182373,-0.02935791,-0.121032715,0.030181885,0.10992432,-0.019424438]	0	\N	\N	f	t	Time waits for no man. Unless that man is Chuck Norris.
18	Chuck Norris once won a staring contest against his own reflection.	\N	0	0	0	0	2026-03-31 05:08:25.321496+00	2026-04-01 18:56:59.877+00	[-0.021484375,0.025314331,-0.036193848,0.014839172,0.027252197,0.105529785,0.06402588,0.06768799,-0.08868408,0.023422241,0.025375366,-0.0045166016,0.061553955,-0.020553589,-0.008888245,0.0066719055,-0.1104126,-0.04736328,-0.048675537,0.07611084,-0.03439331,0.046966553,0.059173584,-0.016693115,0.04840088,0.06896973,0.091674805,-0.050964355,0.09851074,-0.00026369095,0.03741455,-0.029830933,-0.01675415,0.019439697,0.020599365,0.016204834,0.06573486,0.024459839,-0.117248535,-0.0034809113,0.015548706,-0.048187256,0.039916992,0.01751709,0.042114258,-0.07397461,0.007270813,-0.07879639,0.040771484,-0.02520752,-0.0847168,0.016067505,0.046051025,0.109802246,-0.019332886,0.0052223206,-0.048339844,0.02406311,-0.06945801,0.00062942505,0.03149414,-0.061950684,0.0020523071,0.023162842,-0.042236328,-0.03378296,0.05682373,0.020462036,0.08673096,0.045959473,0.021118164,-0.0010671616,-0.019470215,0.030700684,-0.017364502,-0.0022907257,0.01576233,0.04220581,0.10253906,0.037994385,0.06677246,-0.023712158,0.014915466,-0.009941101,0.030731201,0.042633057,-0.023117065,0.020812988,-0.048095703,-0.008575439,-0.036499023,0.06719971,0.027450562,-0.11529541,0.06274414,0.029418945,0.0039520264,0.026031494,0.10070801,0.0035057068,0.010299683,0.02720642,0.00067949295,0.06573486,-0.011512756,0.16894531,0.026870728,0.011856079,-0.05517578,0.050323486,-0.02998352,-0.033721924,0.012802124,-0.06738281,-0.044433594,-0.031555176,0.023742676,0.05718994,0.002374649,0.041229248,0.11212158,0.0440979,-0.010658264,-0.06713867,0.038757324,-0.026443481,0.056274414,0.026229858,-0.022476196,-0.113586426,0.056884766,-0.05117798,0.009841919,-0.027664185,-0.06585693,-0.04989624,-0.064575195,-0.04360962,-0.011238098,0.038757324,-0.051971436,0.008522034,-0.022964478,-0.013404846,0.08905029,0.017028809,0.01473999,0.021911621,0.004020691,-0.013450623,0.0637207,-0.023330688,-0.039489746,0.0041236877,-0.048461914,0.0051956177,0.03643799,-0.017410278,-0.037322998,0.054229736,0.05807495,-0.016281128,-0.05142212,0.03378296,0.0051193237,0.052703857,0.07739258,0.06311035,-0.010772705,-0.06488037,0.003293991,0.030258179,0.13012695,-0.11187744,0.030059814,0.05935669,-0.012176514,-0.013381958,-0.03262329,0.0390625,-0.0062065125,-0.005470276,0.04663086,-0.009674072,0.019348145,0.059326172,-0.010925293,-0.031951904,0.0715332,-0.044403076,-0.052764893,0.05203247,-0.022613525,0.051330566,0.0015335083,-0.059936523,0.06439209,-0.048675537,-0.033355713,-0.06945801,0.016555786,0.020904541,-0.05303955,-0.009506226,0.03463745,0.0087509155,0.09893799,0.039764404,-0.0519104,0.06414795,0.071777344,0.0211792,-0.0018854141,-0.019073486,-0.044830322,-0.059631348,0.05441284,-0.08514404,-0.085632324,0.03265381,0.041656494,0.06341553,0.14025879,0.05392456,0.04324341,0.05178833,0.015930176,0.019805908,0.035339355,0.035003662,-0.051635742,0.007156372,0.0065345764,-0.050628662,0.012771606,0.055847168,-0.019424438,-0.05218506,0.043762207,0.018615723,-0.010131836,-0.014862061,0.008590698,-0.020767212,-0.054656982,-0.0064888,-0.06958008,0.033416748,-0.040222168,-0.011474609,0.009613037,0.035339355,-0.00052928925,0.037902832,-0.03289795,-0.008590698,0.004180908,-0.117248535,0.02128601,0.017166138,0.03161621,0.05706787,-0.09753418,-0.07684326,-0.09283447,0.006175995,-0.038360596,0.0067253113,0.051116943,0.021453857,0.10681152,-0.011917114,0.006969452,0.03829956,-0.046569824,-0.083984375,0.045684814,0.037628174,-0.02168274,0.028823853,-0.030517578,0.1239624,0.004852295,-0.12176514,-0.00705719,-0.020431519,-0.029205322,-0.015235901,0.011451721,-0.08276367,-0.04309082,-0.109375,0.10479736,0.1427002,-0.029556274,-0.05065918,-0.04510498,0.019058228,0.06854248,-0.0423584,0.048919678,-0.010101318,0.015960693,0.060394287,-0.04598999,0.06573486,0.033477783,0.018920898,0.13024902,-0.049682617,-0.02456665,0.014656067,-0.04699707,-0.045074463,-0.044952393,-0.012557983,0.00046563148,0.044677734,-0.032836914,0.016433716,0.025985718,0.07098389,0.027053833,0.047332764,0.023025513,0.053955078,0.09613037,-0.0037727356,0.0010890961,0.012367249,-0.0077056885,-0.017929077,-0.07287598,-0.027114868,0.056030273,-0.016616821,-0.08673096,0.0075683594,-0.029663086,-0.09588623,-0.10040283,0.03237915,-0.008995056,-0.003408432,-0.023986816,-0.037078857,0.042388916,-0.0040893555,-0.057128906,-0.054840088,-0.06896973,0.083984375,-0.03982544,-0.02230835,0.021774292,0.050689697,-0.1204834,0.03918457,0.040008545,0.059265137,-0.025024414,0.057617188,0.0069351196,-0.032714844,-0.027954102,-0.06402588,-0.033996582,-0.041900635,0.052124023,0.011276245,-0.015029907,0.13208008,-0.015258789,0.040008545,-0.011138916,0.12805176,0.01902771,0.0025119781,-0.0029277802,-0.052612305,-0.045684814,0.029800415,0.060668945,-0.0063438416]	0	\N	\N	f	t	Chuck Norris once won a staring contest against his own reflection.
20	Chuck Norris counted to infinity twice without a calculator.	\N	0	0	0	0	2026-03-31 05:08:25.490551+00	2026-04-01 18:57:01.477+00	[0.019927979,-0.0034389496,0.04525757,-0.013999939,0.04699707,0.07507324,0.0012340546,0.012863159,-0.047851562,-0.00082302094,0.05911255,0.01701355,0.0037345886,0.013580322,0.019729614,0.035736084,-0.0803833,0.01939392,-0.034820557,0.03970337,-0.052459717,0.013412476,0.053588867,0.005378723,0.11126709,-0.045684814,0.050750732,0.004131317,0.022216797,-0.018051147,0.09552002,-0.022888184,-0.014984131,0.012084961,0.0016918182,-0.0362854,0.088012695,-0.013038635,-0.04815674,-0.023834229,-0.02053833,-0.06713867,0.02532959,0.016693115,0.029418945,0.008453369,-0.012145996,-0.038604736,0.05508423,0.07092285,-0.0036239624,-0.008407593,-0.015686035,0.078552246,0.032440186,-0.004096985,-0.016342163,-0.0063591003,-0.011756897,-0.024597168,0.03475952,-0.095336914,0.00869751,-0.022583008,-0.04220581,0.013305664,0.04220581,-0.022399902,0.0289917,0.059692383,-0.11785889,0.051727295,-0.0390625,0.07324219,0.06359863,0.0071640015,-0.02279663,0.0061454773,-3.9100647e-05,0.020935059,0.068481445,0.012458801,-0.019332886,-0.072143555,0.08074951,0.09210205,0.031829834,-0.017044067,-0.020385742,-0.044311523,-0.055541992,0.020706177,-0.021987915,-0.051879883,0.05432129,-0.034088135,0.07128906,0.097473145,0.057495117,-0.011871338,0.019622803,0.035339355,0.09979248,0.0018701553,0.0053253174,0.16992188,-0.06878662,-0.046813965,-0.082092285,-0.02293396,-0.015083313,-0.015037537,-0.030838013,-0.092041016,0.0013408661,0.042510986,-0.02758789,0.052642822,-0.010650635,0.016296387,0.09490967,0.012054443,0.07928467,-0.026748657,0.026733398,-0.052001953,-0.062194824,0.09112549,0.05215454,-0.016586304,0.01939392,-0.067993164,0.047698975,0.018066406,-0.025054932,-0.017868042,-0.05886841,0.004676819,0.001367569,0.052001953,-0.021118164,-0.027694702,-0.030731201,0.01878357,0.03878784,-0.03277588,-0.0017242432,0.032165527,0.08215332,-0.07678223,0.014022827,-0.02279663,-0.018096924,-0.04840088,-0.013320923,0.013137817,0.033966064,-0.0057029724,0.05618286,0.09851074,0.0042533875,0.05218506,-0.038635254,0.045196533,-0.034606934,0.1015625,0.0127334595,-0.075805664,-0.047668457,-0.070739746,-0.021499634,-0.0021572113,0.055541992,-0.13769531,0.05218506,0.0093688965,-0.004295349,-0.035095215,-0.06903076,0.06414795,-0.017669678,0.025772095,0.02053833,0.035491943,0.017608643,0.009788513,0.05911255,-0.030685425,0.087524414,0.044555664,-0.010818481,0.040039062,0.026504517,0.055999756,-0.02281189,-0.11431885,0.10394287,-0.14147949,-0.026123047,-0.06262207,-0.03048706,0.06781006,0.036132812,-0.043151855,0.05545044,-0.0011291504,0.051818848,-0.01234436,-0.031311035,-0.032073975,0.0769043,0.010398865,-0.027694702,-0.010688782,-0.07110596,-0.03186035,0.13635254,-0.026321411,-0.081970215,-0.027862549,-0.06347656,0.04815674,0.015136719,-0.019302368,0.074279785,0.041656494,0.025772095,0.07489014,0.014518738,0.12731934,-0.0134887695,0.052581787,-0.015060425,-0.04611206,0.036224365,0.061401367,0.03074646,-0.016098022,-0.072753906,0.027877808,-0.05593872,-0.015342712,-0.041107178,-0.026901245,-0.064697266,-0.012428284,-0.051116943,0.066101074,0.046295166,-0.020523071,-0.015617371,-0.0016012192,0.022506714,0.00970459,-0.09777832,-0.029418945,-0.0032424927,-0.04336548,0.13220215,0.05883789,0.00091314316,-0.08502197,-0.18347168,-0.033569336,-0.089660645,0.06793213,-0.020217896,0.00029563904,-0.010810852,-0.0017223358,0.103271484,0.03253174,-0.00065755844,-0.038482666,-0.045288086,-0.07281494,0.013793945,-0.010772705,-0.018966675,-0.030029297,-0.01689148,0.02305603,-0.0073661804,-0.041931152,0.07305908,-0.06317139,0.010231018,0.08282471,0.075683594,-0.16601562,0.052093506,0.002231598,0.022369385,0.047851562,-0.0881958,-0.040100098,-0.017868042,0.0068626404,0.024673462,-0.022415161,-0.017990112,0.04043579,0.0042495728,0.034423828,-0.07446289,0.08935547,-0.035064697,0.042053223,0.10571289,0.061553955,0.022521973,0.066833496,-0.0031089783,-0.049621582,0.00074481964,-0.070251465,-0.06921387,-0.017074585,0.024780273,-0.029052734,0.08843994,0.015419006,0.041625977,0.020889282,-0.013824463,0.10491943,0.07989502,0.01449585,0.04159546,0.0023269653,-0.06903076,-0.040985107,0.0058403015,-0.01260376,-0.06088257,0.052490234,-0.017044067,0.01878357,-0.05038452,-0.02772522,-0.01574707,0.039154053,-0.017059326,-0.000187397,-0.05218506,-0.037994385,0.041900635,-0.0014953613,0.025009155,-0.012710571,0.0051841736,0.043945312,0.02909851,0.049346924,0.010902405,0.009536743,-0.0496521,0.02230835,-0.019973755,0.056427002,-0.121398926,0.06097412,0.0061798096,0.020233154,-0.05105591,-0.011779785,-0.03842163,-0.03933716,0.003578186,0.028900146,-0.032958984,0.09875488,0.06762695,-0.0075531006,0.008415222,0.06842041,0.025756836,0.005470276,0.048217773,-0.047454834,-0.015670776,0.101867676,0.07507324,-0.03111267]	0	\N	\N	f	t	Chuck Norris counted to infinity twice without a calculator.
21	Chuck Norris does not sleep, he waits patiently for the world to slow down.	\N	0	0	0	0	2026-03-31 05:08:25.574835+00	2026-04-01 18:57:02.178+00	[-0.01928711,0.08746338,-0.034606934,-0.0016555786,-0.0042037964,0.084472656,0.093566895,0.048583984,-0.068359375,-0.050445557,-0.05432129,0.091796875,-0.03375244,0.034454346,0.0039901733,0.025268555,-0.068115234,-0.045318604,-0.0211792,-0.00014400482,-0.08117676,-0.022994995,0.013221741,-0.012969971,0.07293701,0.037384033,0.12585449,0.002319336,0.03173828,0.00894928,0.079711914,-0.058135986,-0.062805176,0.01474762,0.07159424,-0.021377563,0.08001709,-0.02973938,-0.07739258,0.0065841675,-0.035308838,-0.1083374,-0.013320923,0.010795593,0.06112671,-0.04449463,-0.014160156,-0.077819824,0.068481445,0.07531738,-0.064086914,0.009033203,-0.06958008,0.1303711,0.009841919,-0.014320374,0.0018777847,-0.045898438,0.024383545,0.062469482,0.015731812,-0.07312012,-0.024673462,0.008865356,-0.024093628,-0.0758667,0.008491516,-0.061065674,-0.00022256374,0.023330688,-0.07244873,0.052001953,-0.0076179504,0.03414917,0.032928467,0.09802246,0.009475708,0.029647827,0.0368042,0.060394287,0.021911621,0.028625488,-0.011108398,-0.023635864,-0.025314331,0.017669678,-0.016281128,0.017303467,0.028808594,-0.025405884,0.019180298,0.060455322,-0.044311523,-0.026626587,0.01802063,0.014335632,0.1003418,0.0690918,0.05203247,-0.01953125,0.04525757,0.008758545,0.025375366,0.011230469,0.00012803078,0.10461426,-0.055908203,-0.005844116,-0.105163574,0.0019407272,-0.06124878,-0.059020996,-0.06237793,0.003982544,-0.0066490173,0.0044822693,-0.00012385845,0.07525635,0.067871094,0.09210205,0.12194824,0.04144287,-0.044006348,0.0703125,-0.023925781,0.02015686,-0.027511597,0.018737793,-0.03277588,-0.00573349,-0.006450653,-0.05645752,0.021011353,-0.034332275,-0.0011796951,-0.024749756,-0.08880615,-0.022857666,-0.08404541,0.071899414,-0.076171875,-0.04559326,-0.03842163,0.035064697,-0.0072784424,0.035461426,0.0056533813,0.05596924,-0.01626587,0.023849487,0.00012290478,-0.022354126,-0.0009236336,0.024398804,-0.0496521,0.0574646,0.088256836,0.011909485,-0.033355713,0.11993408,0.026260376,-0.016021729,-0.03363037,0.066589355,0.034851074,0.043640137,0.025802612,-0.05618286,-0.03729248,-0.048797607,0.023071289,-0.029510498,0.042633057,-0.05343628,0.08050537,0.087524414,-0.015617371,0.064208984,-0.03552246,0.04727173,0.03515625,0.013130188,0.064086914,-0.060943604,0.029388428,0.023483276,-0.042755127,0.011047363,0.01335907,0.0069618225,-0.028381348,0.04425049,0.031463623,0.042144775,0.010124207,-0.0284729,0.019226074,-0.026382446,-0.019622803,-0.01008606,-0.075683594,0.033721924,0.027908325,-0.11993408,0.057037354,0.06335449,0.05609131,0.0075912476,-0.024551392,-0.035217285,0.06524658,0.030136108,0.022903442,-0.017028809,-0.047790527,-0.08770752,-0.007987976,0.026245117,-0.11529541,-0.03314209,-0.0115356445,-0.011154175,0.023529053,0.07574463,0.080078125,0.08544922,0.010665894,-0.015655518,0.0062828064,0.10424805,0.029159546,0.10595703,0.0041122437,-0.08666992,-0.02154541,0.0076942444,-0.033050537,-0.0317688,-0.034301758,0.020690918,-0.060760498,-0.06121826,-0.10827637,-0.030517578,-0.09838867,-0.048431396,-0.03729248,-0.04156494,-0.007820129,0.06738281,0.0056991577,0.05734253,0.03955078,-0.042114258,-0.0703125,0.0435791,0.015182495,-0.039764404,-0.043914795,0.09136963,0.014755249,0.0077781677,0.06439209,-0.04586792,-0.011421204,0.008705139,-0.01411438,-0.17932129,0.12646484,0.039154053,0.109313965,-0.054534912,-0.036621094,0.009315491,-0.034240723,-0.023086548,0.017318726,0.0065612793,-0.047027588,-0.017974854,-0.07678223,0.01763916,0.062927246,-0.039093018,-0.0073013306,-0.008995056,0.0021915436,0.03427124,0.051208496,-0.052001953,0.05130005,-0.08312988,0.041381836,0.06695557,-0.02482605,-0.10205078,-0.022994995,0.053833008,0.04547119,-0.052093506,0.042388916,0.015716553,0.015853882,0.013221741,-0.07525635,0.05441284,-0.0362854,-0.05999756,0.03955078,0.0062942505,-0.07879639,0.099487305,-0.007286072,-0.12225342,-0.068847656,-0.035888672,0.00021827221,0.024429321,0.039245605,-0.0501709,0.027694702,0.001461029,0.03768921,0.023727417,0.017944336,0.03741455,0.11621094,-0.011177063,0.026687622,0.0385437,-0.05355835,-0.06311035,-0.020446777,-0.0019741058,0.049743652,0.060058594,-0.037841797,-0.028625488,-0.06329346,-0.035308838,-0.060394287,0.010665894,-0.046966553,0.055725098,-0.035186768,-0.027938843,-0.010223389,-0.0007472038,-0.002155304,-0.006126404,0.018066406,0.08404541,-0.024353027,-0.045043945,0.018920898,0.019851685,0.020614624,0.041778564,-0.05114746,0.084472656,-0.07788086,-0.023376465,-0.0049362183,0.008216858,-0.028030396,-0.07824707,-0.04977417,-0.03527832,0.03817749,-0.028030396,-0.005859375,0.13720703,0.028671265,-0.007972717,-0.011070251,0.0791626,0.030380249,-0.008232117,0.035217285,0.0015249252,-0.05908203,0.095703125,0.05734253,0.006259918]	0	\N	\N	f	t	Chuck Norris does not sleep, he waits patiently for the world to slow down.
17	Chuck Norris does not sleep, he waits.	\N	0	0	0	0	2026-03-31 05:08:25.123341+00	2026-04-01 18:57:03.778+00	[-0.0736084,0.09637451,-0.008201599,-0.022415161,0.014427185,0.080566406,0.099853516,0.03869629,-0.05456543,-0.039093018,-0.05834961,0.055908203,0.0044059753,0.03894043,-0.012176514,0.042144775,-0.057495117,-0.036895752,-0.070617676,0.02015686,-0.08154297,-0.00040578842,-0.01235199,-0.003835678,0.076538086,0.06964111,0.09552002,0.011779785,0.00945282,-0.000118255615,0.047851562,-0.060455322,-0.07678223,0.006160736,0.08886719,-0.0042686462,0.08258057,-0.020767212,-0.09246826,-0.019348145,-0.04360962,-0.11828613,-0.0018548965,-0.0018758774,0.030838013,-0.07751465,-0.034454346,-0.08337402,0.052734375,0.0736084,-0.055908203,-0.00843811,-0.0692749,0.10369873,0.006290436,-0.034729004,-0.033416748,-0.05255127,0.01586914,0.066711426,0.010398865,-0.040924072,-0.027069092,-0.006263733,-0.013015747,-0.08319092,0.0018091202,-0.046661377,0.0044555664,-0.0068473816,-0.07800293,0.06512451,0.013389587,0.026733398,0.011787415,0.11645508,0.029327393,0.041748047,0.048095703,0.08239746,0.008934021,-0.002960205,-0.013496399,-0.03616333,0.0018453598,0.0039100647,-0.059570312,-0.0016040802,-0.0031757355,-0.054992676,0.017974854,0.033294678,-0.016571045,-0.039093018,0.0046043396,0.060058594,0.11224365,0.04647827,0.029769897,-0.05480957,0.014945984,-0.012939453,0.014350891,0.024398804,-0.009681702,0.10522461,-0.056610107,0.005466461,-0.067871094,0.052246094,-0.025238037,-0.087768555,-0.02178955,0.00054359436,-0.013969421,0.0014314651,0.041229248,0.053955078,0.049316406,0.10015869,0.15686035,0.06793213,-0.03591919,0.04156494,-0.0024852753,0.034240723,-0.00970459,0.012199402,-0.025863647,-0.007896423,0.019683838,-0.07324219,0.062286377,-0.0025291443,-0.029586792,-0.010986328,-0.09124756,-0.05303955,-0.09063721,0.04711914,-0.059936523,-0.048553467,-0.042510986,0.013763428,-0.032958984,0.0006785393,-0.011894226,0.049194336,0.001285553,-0.0104904175,0.016174316,-0.020767212,-0.0061569214,0.025650024,-0.07128906,0.061767578,0.058746338,-0.00957489,-0.01737976,0.114990234,0.0016422272,0.012496948,-0.047729492,0.042663574,-0.010246277,0.045440674,0.032043457,-0.0435791,-0.027786255,-0.023391724,0.03503418,0.003200531,0.06915283,-0.038085938,0.07043457,0.059143066,-0.006538391,0.066101074,-0.030349731,0.028503418,0.044006348,0.011558533,0.068359375,-0.038757324,0.030807495,0.033416748,-0.0026378632,2.0384789e-05,0.044128418,0.03012085,0.003168106,0.033081055,0.07299805,0.06378174,-0.022323608,-0.037872314,0.0076065063,-0.059661865,-0.0040397644,-0.036315918,-0.07458496,0.0715332,0.033447266,-0.11785889,0.03677368,0.08319092,0.07751465,0.012748718,-0.010185242,-0.046325684,0.08166504,0.0009126663,0.032440186,-0.017211914,-0.08807373,-0.08758545,0.007835388,0.016403198,-0.1340332,-0.01322937,-0.029067993,0.00504303,0.025970459,0.057128906,0.09814453,0.13891602,0.01739502,-0.041534424,-0.00920105,0.10852051,0.018692017,0.105041504,-0.008033752,-0.099853516,-0.010269165,0.0051345825,-0.049713135,-0.021530151,-0.018569946,0.04272461,-0.020614624,-0.039855957,-0.10430908,-0.03237915,-0.061706543,-0.03274536,-0.01966858,-0.03237915,-0.009376526,0.077941895,-0.02079773,0.05731201,0.05569458,-0.01737976,-0.07141113,0.036956787,0.0025291443,-0.033599854,-0.040283203,0.06915283,0.011238098,0.012199402,0.042175293,-0.04510498,-0.041992188,0.016235352,-0.017852783,-0.15893555,0.09576416,0.016708374,0.08984375,-0.03274536,-0.033599854,0.012779236,0.002193451,-0.022354126,0.00032806396,0.031982422,-0.035980225,0.0071983337,-0.09448242,0.029663086,0.027938843,-0.052215576,0.0143585205,-0.0051078796,-0.013366699,0.027648926,0.04626465,-0.021133423,0.02734375,-0.06591797,0.040893555,0.04385376,0.0031814575,-0.089416504,-0.015365601,0.02571106,0.06304932,-0.042510986,0.025726318,0.0670166,0.032470703,-0.0043678284,-0.086242676,0.03503418,-0.022094727,-0.027862549,0.018554688,0.00026488304,-0.06378174,0.063964844,-0.027252197,-0.11956787,-0.061676025,-0.025497437,0.01889038,0.010757446,0.007820129,-0.058258057,0.05142212,0.017791748,0.0546875,0.013496399,-0.018508911,0.053588867,0.10876465,-0.010368347,0.0050697327,0.026824951,-0.027694702,-0.05947876,-0.027801514,-0.034423828,0.04309082,0.07940674,-0.03564453,0.004234314,-0.04260254,-0.055908203,-0.06768799,0.012527466,-0.038085938,0.05368042,-0.03930664,-0.04269409,-0.023971558,-0.021514893,-0.053771973,-0.02809143,0.043182373,0.11114502,0.020645142,-0.07525635,-0.02192688,0.016067505,0.025497437,0.0446167,-0.0045394897,0.08459473,-0.09729004,0.000109791756,-0.021957397,0.0103302,-0.022705078,-0.0703125,-0.027542114,-0.024597168,0.06890869,-0.0049858093,-0.0005607605,0.14562988,0.035705566,0.0036697388,-0.02418518,0.10583496,0.026947021,-0.0105896,0.025405884,0.01374054,-0.0541687,0.08642578,0.061462402,-0.0068893433]	0	\N	\N	f	t	Chuck Norris does not sleep, he waits.
25	Chuck Norris types at 300 words per minute with his toes only.	\N	0	0	0	0	2026-03-31 05:08:26.0232+00	2026-04-01 18:57:05.152+00	[0.017913818,0.06842041,0.0385437,-0.03753662,-0.011024475,0.080078125,-0.0023498535,0.08850098,-0.033599854,-0.032043457,0.0060157776,0.036987305,-0.030288696,0.087646484,-0.030059814,-0.06298828,-0.0107421875,-0.083618164,0.02168274,0.006111145,-0.035736084,0.01134491,-0.0055274963,-0.02822876,0.09387207,0.037353516,0.060943604,0.024993896,0.017791748,0.027801514,0.019180298,-0.07312012,-0.0023403168,-0.06744385,0.02420044,-0.039031982,0.10241699,-0.020950317,-0.006980896,-0.036193848,-0.044921875,-0.11065674,0.0115356445,0.010826111,0.08117676,0.042663574,0.027038574,-0.02067566,-0.0113220215,0.028320312,-0.04095459,0.031829834,-0.042510986,0.08728027,0.074035645,0.036102295,-0.008148193,-0.033813477,0.033172607,-0.03643799,0.052764893,-0.123291016,-0.0054893494,-0.04788208,-0.038146973,-0.015388489,-0.00843811,-0.003276825,-0.00680542,0.001086235,-0.01725769,0.008621216,-0.08947754,0.05883789,0.0043754578,0.016860962,-0.0848999,0.026428223,-0.0014867783,0.03427124,0.071777344,0.0435791,-0.032318115,-0.053375244,-0.010925293,0.038391113,-0.017547607,-0.01966858,-0.08294678,-0.034240723,-0.04864502,0.012931824,-0.018127441,-0.07745361,0.0847168,-0.021881104,0.02331543,0.070007324,0.065979004,-0.057922363,-0.019866943,0.057403564,0.07006836,-0.016525269,0.022232056,0.15014648,-0.067871094,-0.023635864,-0.05267334,-0.03390503,-0.009513855,-0.022384644,0.0050354004,-0.04336548,0.05380249,0.010177612,0.035308838,0.0619812,0.006706238,0.02041626,0.093566895,0.07324219,-0.011566162,-0.017242432,-0.04446411,0.005847931,-0.058135986,0.08581543,0.007144928,-0.050842285,0.04727173,-0.11462402,0.024398804,0.0059127808,-0.05078125,0.06640625,-0.048217773,0.013877869,-0.08630371,0.112854004,-0.067993164,0.004333496,0.010276794,0.053466797,0.001414299,-0.048553467,-0.055023193,0.04473877,0.01576233,-0.02418518,0.012496948,-0.013214111,-0.029922485,0.000685215,0.03237915,-0.010635376,0.05392456,0.08306885,0.03189087,0.021972656,0.035827637,-0.08123779,-0.068115234,0.016235352,0.04486084,0.08532715,0.062347412,0.026565552,-0.012756348,-0.054260254,-0.03250122,-0.0049819946,0.090270996,-0.08630371,0.1048584,-0.024932861,-0.049682617,-0.004196167,-0.052520752,0.08227539,-0.07305908,0.08074951,0.019256592,0.026809692,-0.024505615,-0.030273438,0.025726318,0.020187378,0.044799805,0.03201294,-0.00762558,0.005634308,0.02619934,0.028060913,-0.04949951,-0.082092285,0.07348633,-0.15234375,0.003211975,-0.052490234,0.04135132,0.07867432,-0.046936035,-0.061035156,0.028060913,0.068237305,0.038330078,0.00091457367,-0.06323242,-0.02178955,0.050750732,0.048828125,-0.02520752,-0.036132812,-0.07824707,0.019561768,0.09100342,-0.018920898,-0.041656494,-0.06732178,-0.03652954,0.01234436,0.053222656,0.018707275,0.0018291473,0.037902832,0.016906738,0.0259552,0.089782715,0.05529785,0.040130615,0.049865723,0.026306152,-0.105163574,0.02142334,0.069885254,-0.009361267,-0.018432617,-0.036254883,-0.008148193,-0.024887085,-0.09869385,0.024795532,-0.029266357,-0.12756348,-0.017181396,-0.057617188,-0.06854248,0.026504517,0.021636963,0.069885254,0.033203125,0.0138549805,0.03955078,-0.05496216,-0.00035309792,-0.021942139,-0.051971436,0.07183838,0.1083374,0.025512695,0.009094238,-0.04144287,0.015808105,-0.04953003,-0.0132369995,-0.0032100677,-0.051879883,0.068725586,0.036376953,0.059173584,0.024856567,-0.05496216,-0.040527344,-0.029266357,-0.038513184,0.024810791,-0.06222534,-0.057495117,-0.0093307495,0.017211914,0.110839844,-0.009628296,-0.045196533,-0.0017147064,-0.039245605,-0.01159668,-0.008781433,0.0690918,-0.0725708,-0.012863159,-0.06390381,0.01739502,0.040740967,-0.041778564,-0.01902771,-0.03274536,0.02532959,0.028884888,-0.03274536,0.004055023,0.028411865,0.045166016,0.02420044,-0.05722046,0.048675537,0.0043258667,-0.02935791,0.05432129,-0.059783936,-0.07714844,0.07244873,-0.042419434,-0.05291748,-0.0748291,-0.04537964,0.011993408,-0.014160156,0.026290894,-0.08227539,0.037139893,0.036010742,0.09466553,-0.0045280457,0.0059509277,0.07885742,0.09118652,0.037902832,0.045959473,-0.0034255981,-0.013786316,-0.070617676,-0.016403198,-0.019348145,0.031021118,0.0715332,-0.1194458,-0.029846191,0.055419922,-0.035217285,-0.09265137,0.04385376,-0.027389526,0.055603027,0.017120361,0.03692627,0.0047187805,0.0552063,0.034088135,0.02558899,0.028137207,0.053009033,-0.02432251,0.055419922,0.040893555,-0.030456543,-0.055145264,0.03805542,-0.050323486,0.01574707,-0.06359863,0.07861328,-0.00573349,0.03942871,-0.04473877,-0.049591064,-0.12768555,-0.031311035,0.03552246,-0.0063667297,-0.05319214,0.12841797,0.03869629,0.071777344,-0.00012743473,0.092285156,-0.025650024,0.0105896,-0.021636963,-0.012054443,-0.059020996,0.08453369,0.13122559,0.006099701]	0	\N	\N	f	t	Chuck Norris types at 300 words per minute with his toes only.
27	Chuck Norris can hear sign language clearly.	\N	0	0	0	0	2026-03-31 05:08:26.419559+00	2026-04-01 18:57:06.129+00	[-0.0030879974,0.09991455,-0.13439941,-0.00869751,-0.0042381287,0.080566406,-0.032562256,0.014755249,-0.10107422,-0.06317139,-0.013908386,0.089416504,-0.013412476,0.1303711,-0.026535034,0.022521973,-0.04257202,0.025482178,-0.011672974,-0.06414795,0.07458496,0.05441284,-0.020263672,0.0072898865,0.11193848,-0.00920105,0.06652832,0.0848999,0.07104492,0.05078125,0.018081665,-0.046875,-0.045074463,-0.008682251,-0.0022354126,-0.068115234,0.05078125,-0.024307251,-0.0715332,-0.06713867,0.041931152,-0.015052795,0.014472961,-0.02822876,0.035003662,0.011062622,-0.021408081,-0.028671265,0.011856079,0.027801514,-0.041168213,0.07409668,-0.032287598,0.12207031,0.0362854,-0.018341064,-0.008415222,-0.0109939575,0.050628662,-0.019927979,-0.006752014,-0.07867432,-0.049865723,-0.053985596,-0.058502197,-0.053253174,-0.009727478,-0.05935669,0.023895264,0.066223145,-0.021255493,-0.017745972,-0.0473938,0.050689697,-0.029006958,0.068725586,-0.11859131,0.061065674,0.00969696,0.02861023,0.053833008,0.020874023,-0.041534424,-0.054016113,-0.01335907,0.014282227,-0.03665161,0.03074646,-0.025863647,-0.009735107,0.01977539,0.006942749,-0.029373169,-0.0869751,0.06958008,0.040100098,0.015365601,-0.03137207,0.08862305,-0.02658081,0.033325195,0.014633179,0.07720947,-0.079833984,0.039642334,0.17456055,0.009422302,-0.02658081,-0.008392334,0.029129028,-0.012741089,-0.031555176,0.07574463,-0.048675537,-0.042877197,-0.049865723,-0.024963379,-0.07489014,0.0026245117,0.066711426,0.06072998,0.008529663,-0.0008955002,0.043395996,0.006752014,-0.021865845,-0.06939697,0.043670654,-0.1104126,-0.05517578,-0.06088257,-0.045074463,0.061584473,-0.018325806,-0.036956787,0.0124435425,-0.07977295,-0.08337402,-0.058685303,0.10424805,0.02684021,-0.022155762,-0.0059051514,0.04083252,-0.05279541,-0.041931152,-0.045288086,0.008216858,0.04095459,0.008453369,-0.012741089,-0.0059051514,-0.0003402233,-0.043273926,-0.070251465,0.016494751,0.017745972,-0.00032544136,0.02810669,0.068359375,0.044433594,0.05050659,-0.02368164,0.07067871,0.033355713,0.03024292,0.08154297,0.015174866,0.019805908,-0.010108948,-0.039123535,0.0362854,0.0385437,-0.080200195,0.14343262,-0.043518066,0.044677734,-0.03668213,-0.021438599,0.019546509,-0.029815674,0.062438965,0.048309326,-0.046966553,-0.019897461,0.05355835,-0.007549286,0.037200928,0.07775879,-0.017730713,-0.036834717,0.012329102,0.07342529,-0.009933472,0.023742676,-0.04800415,0.10144043,-0.105285645,-0.00027799606,-0.08300781,-0.014968872,0.04486084,-0.014732361,-0.09387207,-0.0029640198,-0.005554199,0.028656006,0.047454834,0.05279541,0.0046195984,0.04168701,0.009170532,-0.045074463,0.0044174194,-0.04168701,0.029083252,0.051605225,-0.013755798,-0.06542969,-0.060302734,0.009918213,-0.0028858185,0.04815674,0.020767212,-0.05984497,0.018432617,0.0871582,0.08306885,0.028747559,0.038757324,-0.006931305,0.0206604,0.06970215,0.0060195923,0.030151367,0.0637207,-0.08312988,0.013755798,-0.002878189,-0.003042221,-0.020080566,-0.063964844,0.0034561157,0.050201416,-0.053009033,0.02041626,-0.07904053,-0.022094727,0.016571045,-0.038848877,0.019241333,0.09692383,-0.007259369,0.041809082,-0.057556152,0.03942871,-0.06616211,-0.12487793,-0.00020039082,0.03982544,0.005317688,-0.049682617,0.0033855438,-0.093566895,-0.021240234,-0.04260254,-0.019454956,0.014579773,-0.0129470825,0.070373535,0.03173828,-0.03326416,-0.014183044,0.10412598,-0.05529785,-0.044647217,0.06414795,-0.027053833,0.036895752,0.016540527,-0.07501221,0.07910156,0.0063056946,-0.041137695,-0.047088623,-0.061157227,-0.06726074,-0.06695557,0.02204895,-0.045532227,0.023895264,-0.033843994,0.028030396,0.01701355,-0.042816162,0.00029706955,0.019866943,0.00012362003,-0.013931274,0.0024032593,-0.030532837,0.06048584,-0.031829834,0.04373169,-0.026550293,0.1508789,-0.017669678,-0.037109375,0.08203125,0.006034851,-0.044647217,0.048980713,-0.021270752,-0.022125244,-0.079711914,-0.038146973,0.027633667,-0.005214691,-0.019683838,-0.031402588,0.064086914,0.09118652,0.031311035,-0.0287323,0.0067710876,0.10144043,0.08081055,0.040802002,0.052490234,0.023132324,-0.03781128,-0.029541016,-0.02458191,0.0423584,0.042907715,0.03274536,-0.11187744,-0.036254883,-0.00020730495,-0.05493164,-0.08642578,0.04748535,-0.0574646,0.03010559,-0.011024475,-0.013755798,-0.0690918,-0.013008118,-0.01727295,0.016845703,-0.039978027,0.0090789795,-0.033966064,0.031219482,-0.016799927,0.0008368492,-0.07409668,-0.029129028,-0.057647705,0.045166016,-0.0914917,0.042266846,-0.017120361,-0.0008969307,0.026290894,-0.11450195,-0.09472656,-0.0012598038,0.09509277,-0.029800415,-0.010871887,0.04663086,0.0552063,0.07531738,0.0024261475,0.045135498,-0.014755249,-0.06738281,0.0029296875,-0.074401855,-0.0574646,0.027053833,0.10900879,-0.03366089]	0	\N	\N	f	t	Chuck Norris can hear sign language clearly.
29	Chuck Norris does not wear a watch. He decides what time it is.	\N	0	0	0	0	2026-03-31 05:08:26.69966+00	2026-04-01 18:57:08.076+00	[-0.042510986,0.10015869,-0.066833496,-0.038909912,0.035949707,0.04336548,0.068237305,-0.019348145,-0.031982422,-0.06500244,-0.034851074,0.06365967,0.0036334991,0.048431396,-0.022216797,0.019515991,-0.08691406,-0.026321411,-0.039245605,0.071777344,-0.057525635,0.059661865,-0.010932922,-0.048858643,0.04348755,0.041046143,0.044403076,0.06677246,0.04647827,0.0736084,0.041870117,-0.020767212,0.0010843277,0.028839111,0.005306244,0.004470825,0.117492676,-0.017654419,-0.070373535,0.016448975,-0.096069336,-0.053253174,0.012992859,-0.014175415,0.0067710876,-0.07714844,-0.04421997,-0.0008773804,0.028244019,0.046081543,-0.07366943,-0.0039749146,-0.066101074,0.025115967,0.00091171265,-0.06604004,-0.057800293,0.011062622,0.04953003,0.05303955,0.004447937,-0.094177246,-0.014755249,0.03845215,-0.033111572,-0.060058594,0.016845703,-0.003326416,0.034484863,0.012542725,-0.07122803,0.019134521,0.0070991516,0.060272217,-0.016983032,0.10687256,-0.03692627,0.04269409,0.0413208,0.15307617,0.068359375,-0.006126404,-0.05166626,0.041015625,0.034179688,0.03463745,-0.004802704,0.022872925,-0.042633057,-0.08123779,-0.016113281,0.0043411255,-0.0178833,-0.048309326,-0.0061798096,0.015319824,0.06561279,0.14355469,0.11218262,-0.021209717,0.0069999695,-0.038208008,0.038726807,0.015625,-0.009796143,0.16320801,-0.03149414,0.012336731,-0.08111572,0.02168274,0.010765076,-0.0670166,-0.053344727,0.019088745,-0.019897461,-0.03994751,0.008712769,0.053253174,0.07672119,0.031707764,0.099853516,0.008407593,0.012619019,0.040863037,-0.023742676,0.07611084,-0.07879639,0.05621338,-0.060455322,-0.056274414,-0.0023174286,-0.11236572,0.021530151,-0.04449463,-0.038726807,-0.048431396,-0.0690918,-0.0029315948,-0.1083374,0.11480713,0.008926392,0.0052833557,-0.040924072,0.014587402,0.013763428,0.0016565323,-0.035003662,0.0075569153,0.020462036,0.0045928955,0.01234436,-0.041259766,0.0052490234,0.012535095,0.006839752,0.09069824,0.10192871,-0.04812622,0.009925842,0.14086914,0.053253174,0.067871094,-0.11419678,0.055908203,-0.07647705,0.051574707,0.07354736,-0.081604004,7.891655e-05,0.000831604,-0.005748749,-0.014984131,0.07537842,-0.06750488,0.049835205,0.041229248,-0.0029525757,0.026916504,-0.052825928,0.041503906,0.017150879,0.006526947,0.004764557,-0.03729248,0.05291748,0.04284668,-0.006439209,0.03137207,0.06549072,0.0031986237,-0.01285553,0.05911255,0.04345703,0.029632568,-0.062561035,0.01776123,0.040985107,-0.054840088,-0.0015640259,-0.056671143,-0.028076172,0.13317871,0.014434814,-0.1204834,0.028762817,0.03643799,0.0087509155,0.004901886,-0.016082764,0.036315918,0.038269043,-0.0026721954,0.0063934326,-0.06921387,-0.044647217,-0.033050537,0.060028076,-0.105285645,-0.10974121,-0.07873535,-0.023468018,0.08703613,0.014511108,0.006088257,-0.02571106,-0.0018024445,0.08227539,0.023086548,-0.030136108,0.12133789,-0.020385742,0.053863525,0.050964355,-0.0024662018,-0.0046577454,0.027526855,-0.064575195,-0.027236938,-0.026138306,0.046813965,-0.039733887,-0.06512451,-0.09442139,-0.011436462,-0.09869385,-0.018966675,-0.036712646,0.0016813278,-0.026016235,0.009460449,0.036621094,0.032836914,-0.03503418,0.0009651184,-0.07647705,0.015167236,-0.022491455,-0.015472412,0.027389526,0.070617676,0.01902771,-0.04196167,0.0026855469,-0.03161621,-0.08258057,0.040405273,-0.045684814,-0.10913086,0.010429382,-0.010795593,0.07623291,-0.019760132,-0.049468994,-0.0074424744,-0.045684814,-0.047790527,-0.0073165894,-0.009391785,-0.053253174,0.020309448,0.020065308,0.00983429,-0.007659912,-0.026397705,0.018600464,-0.015060425,0.0021953583,0.101379395,0.08276367,-0.09564209,0.041168213,-0.0030899048,0.023712158,0.04800415,-0.07739258,-0.06274414,-0.011009216,-0.013946533,0.01689148,0.007858276,0.014953613,0.032226562,-0.01727295,0.0011062622,-0.071777344,0.054870605,-0.027175903,0.0129776,0.06439209,-0.01777649,-0.06161499,0.0925293,-0.00756073,-0.042053223,0.035614014,-0.041748047,-0.016098022,0.070373535,0.008453369,-0.082214355,0.01777649,-0.008880615,0.040039062,0.0025691986,-0.016220093,0.06939697,0.1463623,0.013008118,0.04272461,0.022338867,-0.07849121,-0.0869751,-0.025848389,0.03274536,0.035125732,0.048553467,0.006126404,-0.02116394,0.0085372925,-0.018875122,-0.042419434,-0.005760193,-0.037261963,0.0061912537,-0.019943237,-0.039489746,-0.019088745,-0.08026123,-0.0049324036,-0.001077652,0.016357422,0.030090332,-0.014961243,-0.046661377,-0.07897949,0.036834717,0.0034008026,0.044128418,-0.055145264,0.051483154,-0.08148193,0.07501221,-0.031234741,-0.030929565,-0.04071045,-0.06774902,-0.020095825,-0.0090408325,-0.042022705,-0.0027313232,-0.019973755,0.042419434,0.0010986328,0.036621094,0.0014591217,0.06756592,0.0017518997,-0.018310547,0.04800415,0.01864624,-0.03149414,0.03152466,0.11682129,-0.09136963]	0	\N	\N	f	t	Chuck Norris does not wear a watch. He decides what time it is.
24	Chuck Norris counted to infinity three times total.	\N	1	0	1	0	2026-03-31 05:08:25.882314+00	2026-04-01 18:57:09.277+00	[0.009544373,-0.0069732666,0.04724121,-0.008621216,0.033477783,0.061706543,-0.011772156,0.036956787,-0.07904053,0.010505676,0.047180176,0.023590088,-0.0076141357,-0.0045661926,0.033691406,0.03427124,-0.053253174,0.019226074,0.0033817291,0.051574707,-0.07141113,0.018173218,0.072753906,0.027160645,0.09643555,-0.0009431839,0.061157227,0.0053863525,0.06185913,-0.017837524,0.09838867,-0.024536133,-0.013931274,0.033172607,-0.009780884,-0.058898926,0.080078125,-0.00868988,-0.03665161,-0.051635742,0.006034851,-0.07904053,0.031799316,7.2956085e-05,0.018936157,-0.015991211,-0.0015144348,-0.059051514,0.026809692,0.05621338,0.0039901733,0.0019264221,-0.003791809,0.07733154,0.043884277,-0.0033454895,-0.019821167,0.012252808,-0.023330688,-0.042785645,0.0284729,-0.09588623,0.028503418,-0.04019165,-0.038238525,0.021499634,0.016784668,-0.02368164,0.08404541,0.042022705,-0.099243164,0.059387207,-0.0635376,0.07507324,0.07305908,0.05596924,-0.02015686,-0.014472961,-0.023864746,0.02128601,0.089782715,0.015182495,-0.026535034,-0.059509277,0.085754395,0.084472656,0.02319336,-0.012825012,-0.008415222,-0.015533447,-0.07110596,-0.009765625,-0.025482178,-0.061767578,0.04385376,-0.0703125,0.089904785,0.10900879,0.038024902,-0.02468872,0.010917664,0.04638672,0.08850098,-0.016418457,-0.029434204,0.18041992,-0.055023193,-0.014343262,-0.049468994,-0.029541016,0.020095825,0.019714355,-0.011787415,-0.08935547,-0.020904541,0.07904053,0.0036849976,0.060028076,0.009002686,0.017440796,0.10241699,0.0055503845,0.07989502,-0.009918213,0.017730713,-0.070007324,-0.016937256,0.07763672,0.04055786,0.0027923584,0.061065674,-0.039123535,0.02947998,-0.0012264252,-0.037994385,-0.042144775,-0.072753906,-0.025024414,-0.03250122,0.03338623,-0.037628174,-0.046295166,-0.01210022,-0.0070114136,0.08557129,-0.027816772,-0.013664246,0.028503418,0.093322754,-0.07324219,-0.00819397,-0.025161743,-0.0110321045,-0.033355713,-0.0013532639,0.016159058,0.026672363,-0.006839752,0.049865723,0.095581055,-0.005592346,0.036712646,-0.056427002,0.025878906,-0.0056991577,0.099487305,0.014945984,-0.051574707,-0.057739258,-0.085510254,0.011993408,-0.019378662,0.056518555,-0.14489746,0.04598999,0.016723633,-0.038146973,-0.017181396,-0.055633545,0.08026123,0.0001705885,0.05670166,-0.031204224,0.0061149597,-0.005153656,0.024475098,0.07635498,-0.024673462,0.08453369,0.06756592,0.00074243546,0.061950684,0.0070610046,0.075927734,-0.01234436,-0.11175537,0.08166504,-0.14611816,-0.026123047,-0.050354004,-0.0031337738,0.09448242,0.043182373,-0.01626587,0.032592773,0.014892578,0.044403076,0.0018291473,-0.021697998,-0.016860962,0.07745361,0.016693115,-0.049438477,-0.00819397,-0.06100464,-0.02859497,0.09448242,-0.0368042,-0.10546875,-0.041381836,-0.036621094,0.045013428,0.014923096,-0.010665894,0.0826416,0.053253174,0.03753662,0.08453369,0.044189453,0.084228516,-0.016983032,0.046295166,-0.002746582,-0.081848145,-0.0052871704,0.07647705,0.041290283,0.0027809143,-0.049957275,0.011360168,-0.059143066,-0.012535095,-0.01864624,0.0048675537,-0.08392334,-0.027816772,-0.044281006,0.047790527,-0.0045204163,-0.028747559,-0.014053345,0.030670166,0.012565613,0.003047943,-0.08959961,0.021896362,-0.010536194,-0.051849365,0.11138916,0.06781006,0.0046195984,-0.041503906,-0.16760254,-0.024642944,-0.10296631,0.05859375,0.0071754456,-0.0209198,0.03567505,-0.014022827,0.08605957,-0.021728516,0.012252808,-0.04284668,-0.027252197,-0.057006836,0.029296875,0.0027332306,-0.004146576,-0.04864502,-0.010108948,0.026016235,0.0033836365,-0.03112793,0.05947876,-0.0892334,0.035949707,0.1116333,0.07159424,-0.15808105,0.023223877,-0.0096588135,0.036895752,0.062927246,-0.049346924,-0.02760315,-0.011184692,-0.00969696,0.0071983337,0.0023002625,-0.020751953,0.04559326,0.0016555786,0.05709839,-0.06500244,0.105285645,-0.025878906,0.0039596558,0.107421875,0.058288574,0.012870789,0.06518555,-0.042999268,-0.058166504,-0.005832672,-0.06774902,-0.051818848,-0.00674057,0.01574707,-0.010658264,0.059173584,0.024230957,0.02658081,0.047180176,-0.009643555,0.08758545,0.07312012,0.012931824,-0.0073394775,-0.008049011,-0.05810547,-0.034118652,0.007980347,-0.044281006,-0.03744507,0.04937744,-0.016799927,0.008529663,-0.053253174,-0.05050659,0.004360199,0.030334473,-0.0018758774,0.01423645,-0.0692749,-0.010803223,0.033599854,-0.011238098,0.02407837,-0.02407837,0.013092041,0.025665283,0.024993896,0.02949524,0.019958496,0.009490967,-0.04748535,0.028564453,-0.010879517,0.052886963,-0.105285645,0.0848999,0.02760315,-0.010032654,-0.064453125,-0.038024902,-0.07977295,-0.036132812,0.02142334,0.044891357,-0.03567505,0.09234619,0.04373169,-0.010528564,0.025131226,0.11810303,0.022842407,0.0065689087,0.04232788,-0.051239014,-0.042419434,0.07171631,0.07897949,0.015090942]	0.20654329147389294	\N	\N	f	t	Chuck Norris counted to infinity three times total.
2	Chuck Norris can divide by zero.	\N	0	0	0	0	2026-03-31 05:08:21.92375+00	2026-04-01 18:56:16.078+00	[-0.0030231476,0.04397583,-0.024780273,0.006542206,0.08227539,0.0061149597,-0.028213501,0.04168701,-0.029571533,-0.003250122,0.014198303,0.0054016113,-0.012756348,0.09698486,0.028198242,0.026016235,0.0029964447,0.020309448,-0.020462036,0.064941406,-0.06124878,0.055786133,0.05050659,-0.043670654,0.059387207,0.039245605,0.11303711,0.020828247,0.044830322,-0.0071525574,0.07714844,-0.04083252,-0.04260254,0.068725586,0.0062179565,0.03729248,0.039886475,0.019470215,-0.062927246,0.017028809,-0.014770508,-0.08984375,-0.012626648,0.014846802,0.031707764,-0.01612854,-0.022079468,-0.068481445,0.070007324,-0.026412964,-0.07043457,-0.038879395,0.015655518,0.04626465,-0.054718018,-0.016540527,-0.031463623,0.013427734,0.039611816,-0.0045547485,0.014694214,-0.09857178,0.010314941,-0.04827881,-0.02861023,-0.016342163,0.024032593,-0.032836914,0.054016113,0.047088623,-0.09234619,0.031982422,-0.020812988,0.05340576,0.043792725,0.097473145,-0.017150879,0.021408081,-0.009384155,-0.0067863464,0.09820557,0.035614014,0.0061683655,0.012054443,0.04296875,0.10028076,-0.007019043,0.02217102,-0.056488037,-0.016586304,-0.088134766,0.052246094,-0.043518066,-0.054992676,0.07727051,-0.030731201,0.0826416,0.03982544,0.07055664,-0.06512451,0.0046310425,0.03616333,0.041809082,0.009017944,0.058807373,0.15136719,-0.081848145,-0.029220581,-0.0814209,0.022460938,0.036071777,-0.0309906,0.027679443,-0.123291016,-0.06726074,0.014450073,0.019760132,0.029846191,-0.0657959,0.012519836,0.059570312,-0.017059326,0.061798096,-0.014572144,-0.02319336,-0.0066337585,-0.018798828,0.011917114,-0.017196655,-0.040527344,0.03314209,-0.0073051453,0.014038086,0.010902405,-0.024734497,0.0027885437,-0.09246826,-0.02180481,-0.013549805,0.060577393,-0.046325684,-0.0074272156,-0.00068616867,0.0028800964,0.043884277,-0.07409668,-0.022705078,0.07922363,0.0657959,0.016342163,0.105407715,-0.04849243,0.017333984,-0.04937744,-0.026672363,0.08520508,0.055999756,-0.030944824,-0.0036792755,0.012687683,0.07946777,0.08215332,-0.029708862,0.038146973,-0.06561279,0.053222656,0.02407837,-0.035247803,-0.043884277,-0.10522461,0.00067043304,-0.04397583,0.007888794,-0.1730957,0.013084412,0.056610107,-0.0076789856,-0.023544312,0.024719238,0.06298828,-0.0016002655,0.11193848,0.06185913,-0.015388489,-0.012664795,0.07330322,0.033172607,-0.026062012,0.06341553,-0.017715454,-0.06713867,0.054992676,0.016448975,0.099609375,0.04385376,-0.07672119,0.090026855,-0.08306885,0.02130127,-0.027755737,-0.0206604,0.0826416,0.03967285,-0.037475586,0.04220581,-0.020004272,0.040649414,0.0039253235,-0.054229736,-0.057281494,0.027069092,-0.023376465,-0.025726318,-0.0446167,0.005142212,-0.05581665,0.061279297,0.013130188,-0.089904785,-0.023849487,-0.07745361,0.04776001,0.04611206,-0.0030460358,0.036102295,0.06726074,0.039916992,0.032104492,0.078063965,0.13146973,-0.006828308,0.05859375,-0.023880005,-0.041931152,-0.006160736,0.01763916,-0.057556152,0.0006108284,-0.066589355,0.06567383,-0.077697754,-0.032989502,0.05722046,-0.018310547,-0.03869629,-0.0035591125,-0.016601562,0.022903442,0.043273926,-0.017028809,0.020492554,0.039123535,0.009117126,0.0037631989,-0.1026001,-0.005760193,-0.03488159,-0.05307007,0.08319092,0.04071045,-0.03338623,-0.015319824,-0.097839355,-0.019836426,-0.030014038,0.036499023,-0.04159546,0.013046265,-0.00037407875,0.03491211,0.13244629,0.016235352,0.0079956055,-0.07928467,-0.05718994,-0.049468994,0.036468506,0.022598267,-0.043670654,-0.023010254,-0.083618164,0.06616211,0.064575195,-0.07269287,0.054718018,-0.071899414,-0.05343628,0.02230835,0.039764404,-0.13269043,0.06933594,0.011810303,-0.007827759,0.06225586,-0.03189087,-0.031082153,-0.045715332,-0.060302734,0.02507019,-0.017028809,0.02520752,0.036956787,-0.01637268,0.013244629,-0.028945923,0.030014038,-0.013534546,0.05633545,0.07507324,0.0059318542,-0.086364746,0.112976074,-0.06011963,-0.0006284714,-0.03149414,-0.029968262,-0.027816772,-0.061798096,0.017608643,-0.0014753342,0.06750488,0.053955078,0.0040397644,0.014122009,-0.0009560585,0.09289551,0.09710693,0.03515625,0.04498291,0.030639648,-0.06085205,-0.020935059,-0.045288086,0.01939392,-0.024673462,-0.016784668,-0.0018014908,0.052642822,0.011405945,-0.08874512,-0.04827881,0.04953003,0.038238525,0.03010559,-0.09790039,-0.03149414,0.05545044,-0.020904541,0.019958496,-0.015266418,-0.0904541,0.05130005,-0.027938843,0.018844604,0.012039185,0.06414795,-0.042510986,-0.043701172,-0.042755127,0.059661865,-0.06518555,0.060638428,0.0039787292,0.012802124,0.045715332,-0.010520935,-0.06500244,-0.06951904,0.06756592,0.013153076,-0.043304443,0.11401367,0.022964478,-0.021514893,-0.005634308,0.057922363,-0.008079529,-0.009010315,0.07867432,-0.03527832,-0.06713867,0.04989624,0.10827637,-0.060272217]	0	\N	\N	f	t	Chuck Norris can divide by zero.
5	Superman wears Chuck Norris pajamas.	\N	0	0	0	0	2026-03-31 05:08:22.640423+00	2026-04-01 18:56:21.909+00	[0.0010118484,0.023757935,-0.06311035,0.025024414,0.08666992,0.034484863,0.13867188,0.07055664,0.020523071,-0.013763428,-0.04724121,0.068847656,-0.05718994,0.014228821,-0.013885498,0.02720642,-0.0184021,-0.04309082,-0.041778564,0.026351929,-0.037261963,0.036743164,0.02053833,-0.01576233,0.0022583008,0.040130615,0.0044517517,0.012512207,0.109191895,0.054138184,-0.007019043,-0.0211792,-0.009124756,-0.006843567,0.050598145,-0.014213562,-0.0149002075,0.039001465,-0.014633179,0.08062744,0.020568848,-0.09173584,-0.017532349,0.024383545,-0.0030822754,-0.044311523,0.012214661,-0.010253906,0.031463623,0.01133728,-0.03768921,-0.0836792,-0.062408447,0.0748291,-0.015899658,0.0073432922,-0.06213379,-0.009750366,-0.060546875,0.0066719055,-0.016677856,-0.058563232,-0.025314331,0.031433105,-0.0690918,0.0014123917,0.04446411,-0.030059814,0.04647827,0.035614014,0.017745972,0.048461914,-0.07269287,0.06384277,-0.0062217712,0.103637695,0.030029297,0.074645996,0.035217285,0.03050232,-0.03466797,0.040771484,0.031799316,0.032592773,-0.054656982,0.00039100647,-0.019592285,0.064819336,-0.0146102905,0.030319214,0.015434265,0.012931824,-0.109375,-0.07501221,-0.014312744,0.09918213,0.040100098,-0.0055236816,0.04171753,-0.011436462,0.082458496,0.0039367676,0.019042969,0.09289551,0.02696228,0.1315918,-0.014984131,0.09442139,-0.031280518,-0.029327393,-0.021972656,0.034729004,-0.015457153,0.0060310364,-0.0927124,0.024215698,0.011993408,0.0357666,0.06500244,0.030914307,0.09753418,0.040863037,0.027297974,0.0033626556,-0.06591797,0.049682617,0.008323669,0.020721436,-0.06719971,0.03164673,0.027633667,-0.0602417,-0.033813477,-0.032409668,-0.021743774,0.022384644,-0.095947266,-0.07043457,-0.08618164,0.06286621,-0.06311035,-0.03555298,-0.05517578,0.03161621,0.06896973,0.041778564,0.062316895,0.0069847107,0.008560181,0.057769775,0.023986816,-0.015106201,0.033447266,-0.011917114,-0.035614014,-0.0395813,0.07348633,-0.08404541,0.11633301,0.067871094,0.021575928,0.050323486,-0.07928467,0.05569458,0.049041748,-0.019851685,0.14282227,-0.012298584,-0.08770752,-0.027328491,0.029846191,0.0044937134,0.088012695,0.011177063,0.03881836,0.068115234,-0.0098724365,-0.008529663,-0.03866577,0.014892578,0.08123779,0.07373047,0.0017318726,-0.041412354,-0.016647339,-0.009841919,-0.00010341406,0.017562866,0.09710693,0.055511475,-0.00059461594,-0.025161743,-0.033966064,0.024093628,-0.08892822,-0.06866455,0.037109375,-0.06744385,-0.026107788,0.006137848,-0.033966064,0.09564209,0.05239868,0.006477356,-0.04437256,0.016647339,-0.024047852,0.037109375,-0.02784729,-0.025726318,0.13000488,0.03756714,-0.03439331,-0.04949951,-0.08068848,-0.08441162,0.0015764236,0.012260437,-0.034576416,0.020599365,-0.054595947,0.072143555,0.015151978,0.013557434,0.044921875,0.09338379,-0.028289795,-0.02178955,0.0037841797,0.082214355,0.033569336,0.033050537,-0.025222778,-0.07513428,-0.055511475,-0.0018539429,-0.024032593,-0.0017004013,-0.03378296,0.019699097,-0.091796875,0.016036987,-0.0027503967,0.04232788,-0.064819336,-0.027954102,-0.004169464,-0.040740967,-0.035308838,-0.07104492,0.059295654,0.10443115,-0.040130615,0.040527344,-0.04537964,-0.045715332,0.0048294067,0.0071029663,0.015823364,0.058807373,-0.04638672,0.029510498,-0.08703613,-0.06896973,-0.08947754,0.026245117,-0.011871338,-0.0881958,0.10443115,0.02897644,0.07312012,0.07330322,0.060913086,0.027618408,-0.0491333,-0.07598877,-0.030593872,0.003200531,-0.036895752,0.020370483,-0.03173828,-0.021575928,0.0491333,-0.00036883354,0.004627228,-0.051086426,-0.023132324,0.054779053,-0.019882202,-0.04837036,0.032196045,-0.008140564,-0.015266418,0.050048828,-0.060699463,-0.030014038,-0.053741455,0.025466919,-0.006340027,0.025817871,0.00970459,0.03994751,0.023864746,0.09674072,0.019195557,0.08856201,0.026504517,-0.035736084,0.063964844,-0.036254883,-0.14025879,0.005718231,-0.013832092,-0.05239868,-0.031280518,-0.044525146,-0.0546875,0.045135498,-0.018737793,-0.042907715,-0.03338623,0.1116333,0.011512756,-0.08862305,-0.05154419,0.044525146,0.045898438,0.004573822,0.019363403,0.009231567,0.014770508,-0.08129883,-0.09857178,-0.025543213,0.031982422,0.021118164,0.053649902,0.019821167,-0.031555176,-0.029037476,-0.040161133,0.03942871,-0.04550171,0.03488159,-0.08905029,-0.010223389,0.017471313,0.0075645447,-0.035461426,-0.03805542,0.10864258,0.09631348,-0.03326416,-0.00920105,-0.022094727,0.0053749084,0.10797119,0.0069770813,0.010108948,-0.03527832,0.0034866333,0.06793213,0.004611969,-0.050689697,-0.06500244,-0.032409668,-0.029449463,0.04220581,0.109191895,-0.018661499,0.04296875,0.093688965,0.10827637,0.026504517,0.051757812,0.115356445,0.053894043,-0.011054993,-0.05343628,-0.060821533,-0.0021076202,0.0826416,0.048187256,-0.018234253]	0	\N	\N	f	t	Superman wears Chuck Norris pajamas.
6	When Chuck Norris enters a room, he doesn't turn the lights on — he turns the dark off.	\N	0	0	0	0	2026-03-31 05:08:22.867314+00	2026-04-01 18:56:23.877+00	[-0.04135132,0.0074157715,-0.08105469,-0.019348145,0.07922363,0.07080078,-0.007091522,0.041107178,-0.026016235,-0.03805542,-0.02458191,0.033050537,0.008163452,0.054595947,0.09448242,0.023376465,-0.07208252,0.022949219,0.029663086,0.071899414,-0.03866577,0.040527344,0.022338867,0.028579712,-0.035949707,0.037261963,0.05731201,0.060791016,0.10333252,0.085998535,0.042663574,-0.010063171,-0.008239746,-0.018249512,0.08709717,0.014846802,0.075927734,-0.018341064,-0.006832123,0.029312134,-0.05908203,-0.05508423,0.034484863,0.05368042,0.07397461,-0.0055732727,-0.06311035,-0.10961914,0.027389526,-0.028198242,-0.07751465,-0.039398193,0.012008667,0.017456055,-0.08782959,-0.029174805,-0.05908203,-0.039031982,0.03277588,0.024047852,0.07873535,-0.035583496,-0.004638672,0.05404663,-0.018966675,-0.013160706,0.005432129,0.028656006,0.010696411,0.03164673,0.00027894974,0.0012331009,-0.06866455,0.04486084,0.058532715,0.054870605,0.0067977905,-0.0042800903,0.0032348633,0.04925537,0.05682373,-0.0075569153,0.012687683,-0.028945923,-0.06890869,0.009674072,-0.07873535,-0.036895752,-0.013809204,0.0016355515,0.006904602,0.02658081,-0.095825195,-0.07775879,0.013031006,0.04724121,0.054382324,0.07897949,0.092285156,-0.01576233,0.06341553,-0.018615723,0.044403076,0.003063202,0.007858276,0.1026001,-0.07354736,-0.03164673,-0.119506836,0.0056381226,0.04837036,-0.05899048,0.105407715,0.0066452026,-0.08428955,-0.04147339,0.0513916,0.097839355,0.04559326,-0.009178162,0.08984375,0.028839111,0.02998352,-0.018035889,0.021011353,-0.055236816,-0.045959473,0.043884277,-0.07348633,-0.0064086914,0.024978638,-0.039886475,0.052612305,-0.016067505,-0.029144287,0.042175293,-0.07788086,-0.01776123,-0.01725769,0.077819824,-0.04586792,-0.008308411,0.027709961,0.0119018555,-0.033294678,-0.008491516,0.0063438416,0.02822876,0.0713501,0.010505676,0.001247406,-0.06359863,-0.06149292,0.024246216,0.0030784607,0.062316895,0.019943237,0.05126953,0.066589355,0.079956055,0.05682373,0.031188965,-0.08123779,0.0028438568,-0.049804688,0.0569458,0.09106445,-0.035705566,-0.044311523,-0.020492554,-0.10479736,0.02784729,0.07598877,-0.056396484,0.054656982,0.019424438,-0.08935547,0.006298065,-0.0284729,-0.012512207,-0.002336502,0.03375244,0.1003418,-0.002828598,0.023452759,-0.01638794,-0.094177246,0.05496216,-0.019302368,-0.008110046,0.003129959,0.022018433,-0.07330322,0.008560181,-0.020462036,0.020355225,0.105651855,-0.026504517,-0.017791748,-0.1048584,-0.009773254,0.072387695,0.06137085,-0.020355225,0.02923584,-0.0012359619,0.041992188,0.05102539,-0.051483154,-0.005569458,0.06994629,0.020980835,-0.04144287,0.0003876686,-0.025924683,0.0029010773,0.080444336,0.08117676,-0.06274414,-0.015052795,0.0068626404,0.01184082,0.043884277,-0.03555298,0.039764404,0.07128906,0.007785797,-0.045532227,0.09008789,0.07867432,0.036315918,0.059295654,-0.019729614,-0.06109619,-0.042053223,0.010124207,-0.026885986,-0.062408447,-0.06921387,0.04989624,-0.029571533,0.01965332,0.008255005,-0.06329346,-0.105407715,-0.00027275085,0.0011854172,-0.026062012,-0.019470215,-0.015838623,0.011016846,0.07702637,-0.04147339,0.0017976761,-0.050811768,-0.019119263,-0.017425537,-0.072143555,0.028762817,0.016204834,-0.02470398,0.0059280396,0.02508545,-0.083496094,-0.10095215,0.054992676,-0.044952393,-0.07867432,0.042114258,0.041229248,0.093811035,0.018295288,0.05645752,-0.024139404,-0.06500244,-0.095214844,0.008453369,0.004043579,-0.041992188,-0.0262146,-0.040924072,0.086242676,0.06878662,-0.05609131,-0.046661377,-0.009681702,-0.002948761,0.11279297,0.029449463,-0.11480713,-0.0045166016,-0.049804688,0.042938232,0.057128906,-0.070007324,0.029418945,-0.01335907,0.0063056946,0.033355713,-0.03262329,0.041381836,0.03363037,0.0059280396,0.028762817,0.008865356,0.05065918,-0.0357666,-0.045196533,0.12219238,-0.03289795,0.0073432922,0.054870605,-0.0013580322,-0.00381279,-0.00762558,-0.0635376,0.02583313,0.013313293,-0.046142578,-0.08465576,-0.033294678,0.10241699,0.037475586,-0.04812622,-0.01663208,0.06591797,0.09490967,0.025466919,0.001950264,0.005683899,-0.017913818,-0.07110596,-0.0023479462,0.017593384,0.0289917,-0.040740967,-0.082336426,0.03894043,-0.035980225,-0.1706543,0.017593384,-0.002981186,-0.040405273,0.08496094,0.004753113,-0.033111572,-0.007820129,-0.04849243,0.043548584,0.045532227,0.04827881,0.046173096,-0.04284668,-0.050048828,-0.035888672,0.039367676,-0.023239136,0.012588501,0.017623901,0.039215088,-0.0657959,0.016662598,0.0064582825,-0.04437256,-0.047790527,-0.09399414,-0.048675537,-0.027893066,0.12524414,0.026062012,0.025466919,0.056915283,0.11968994,-0.035583496,0.02923584,0.0892334,0.005317688,-0.02885437,0.07611084,-0.047973633,-0.061767578,0.06463623,0.07324219,0.010955811]	0	\N	\N	f	t	When Chuck Norris enters a room, he doesn't turn the lights on — he turns the dark off.
10	When Chuck Norris was born, he drove his mom home from the hospital.	\N	0	0	0	0	2026-03-31 05:08:23.827346+00	2026-04-01 18:56:26.004+00	[0.0068740845,-0.014541626,-0.06951904,0.016326904,0.08514404,-0.031433105,0.036499023,0.051940918,-0.088256836,0.032318115,0.027328491,0.118896484,-0.0060157776,-0.0035953522,-0.014480591,0.009979248,-0.0018539429,-0.01071167,-0.08148193,0.019210815,0.022781372,0.036590576,0.12231445,-0.051330566,0.08288574,-0.03164673,0.086364746,-0.01537323,-0.0256958,-0.021438599,-0.017623901,-0.0065612793,0.025772095,-0.014587402,0.0541687,-0.020462036,0.07287598,-0.009979248,-0.0010175705,0.07861328,0.012992859,-0.06817627,0.042633057,0.030578613,-0.03286743,0.02357483,0.026123047,-0.061828613,0.055236816,0.023101807,-0.06463623,-0.1217041,-0.015594482,0.017807007,-0.027267456,0.019226074,-0.028198242,0.009239197,0.041229248,-0.046020508,0.024734497,-0.117248535,-0.016921997,-0.04815674,-0.003332138,0.0463562,0.07739258,-0.017700195,0.0010385513,0.05807495,-0.01828003,0.048461914,-0.09631348,0.063964844,0.03942871,0.1149292,-0.08258057,0.029907227,-0.045776367,0.017166138,0.068847656,-0.023086548,0.034973145,0.008026123,0.022277832,0.05795288,-0.046325684,0.036590576,0.007843018,-0.005001068,0.0118255615,0.041107178,0.007987976,-0.08276367,0.06774902,-0.00919342,-0.009231567,-0.0012569427,0.07562256,-0.064086914,-0.0028457642,-0.07476807,0.03250122,0.062042236,-0.0362854,0.06994629,-0.026168823,0.013877869,-0.08691406,0.024032593,0.044769287,-0.085510254,-0.030441284,0.01134491,-0.09655762,0.11895752,-0.016693115,-0.006752014,-0.066711426,0.09277344,0.048553467,-0.02255249,-0.043762207,-0.043548584,0.09655762,0.01222229,-0.0076179504,0.03817749,-0.07678223,-0.00762558,-0.001789093,0.0054626465,-0.012992859,-0.013076782,0.043548584,-0.00793457,-0.051361084,-0.12646484,-0.07977295,0.046203613,-0.0625,-0.072509766,-0.013298035,-0.022277832,0.049102783,0.019760132,0.002149582,0.095947266,0.031311035,0.05215454,-0.0259552,0.0056266785,-0.051605225,0.021865845,-0.018707275,0.04776001,0.027893066,-0.012573242,0.042266846,0.051086426,-0.017089844,0.03515625,-0.06518555,0.010986328,-0.025360107,0.088256836,0.06335449,-0.026473999,-0.08441162,0.008636475,-0.043060303,0.01737976,0.03378296,-0.02180481,0.03186035,0.009895325,-0.03643799,-0.08654785,0.005634308,0.08996582,0.026351929,0.027297974,-0.0022087097,-0.028182983,-0.019302368,0.08905029,-0.010383606,0.07019043,0.01398468,0.014968872,-0.046020508,-0.0004003048,-0.01902771,0.05218506,-0.021530151,-0.059173584,0.10522461,-0.10974121,-0.03463745,-0.044647217,0.020263672,0.097717285,0.11553955,0.00059890747,-0.04269409,-0.021453857,0.013008118,0.12005615,-0.014442444,-0.025054932,0.06970215,-0.065979004,-0.06549072,0.03857422,0.005027771,-0.039093018,0.06390381,0.028411865,-0.041809082,-0.08929443,-0.011268616,-0.01928711,0.04208374,-0.008644104,0.05316162,0.054870605,0.014640808,-0.048065186,0.045684814,0.055145264,0.03036499,0.08483887,-0.026733398,-0.07672119,-0.020187378,0.05343628,-0.039215088,-0.05038452,-0.0011816025,0.034057617,-0.045898438,0.030288696,-0.0015544891,-0.0075531006,-0.05899048,0.0059013367,-0.010520935,-0.012435913,0.005405426,0.0039520264,-0.0362854,-0.051940918,0.030059814,-0.0016098022,-0.047058105,0.039367676,-0.031021118,-0.015350342,0.11212158,-0.037384033,0.026809692,0.015960693,-0.054595947,-0.055908203,-0.0066833496,0.009559631,0.00030326843,-0.05078125,0.07171631,0.07342529,0.08538818,-0.016448975,0.079711914,0.020553589,-0.06549072,-0.08203125,-0.050354004,0.004875183,0.03289795,-0.06427002,-0.020370483,0.0715332,-0.011306763,-0.074157715,-0.006137848,-0.009056091,0.015319824,0.025894165,0.018081665,-0.09039307,-0.11645508,-0.027908325,0.039855957,0.06097412,0.007232666,-0.01436615,-0.038024902,-0.013305664,0.048858643,0.028549194,0.07067871,0.06274414,-0.014343262,0.038635254,-0.02859497,-0.0025043488,0.0052223206,-0.05871582,0.12768555,0.046539307,-0.0927124,0.052490234,0.02468872,-0.061767578,-0.042266846,0.0715332,0.030181885,-0.027786255,-0.044403076,-0.011978149,-0.009147644,0.121154785,0.03564453,0.059387207,0.021148682,0.11468506,0.10949707,-0.030715942,0.038482666,0.037200928,-0.095214844,-0.09234619,-0.014297485,-0.019165039,0.033569336,0.0103302,-0.040527344,-0.064941406,-0.012107849,-0.08703613,-0.0013828278,0.0006260872,-0.050109863,-0.03225708,-0.040618896,-0.06414795,0.07043457,0.003107071,-0.046905518,0.04067993,-0.04034424,0.056671143,-0.053131104,0.046722412,-0.015533447,0.034423828,-0.027862549,0.0657959,-0.0010404587,0.01574707,-0.06210327,-0.026870728,-0.019958496,0.029067993,-0.04232788,-0.051452637,0.0014457703,0.033996582,0.0012626648,0.022338867,-0.031921387,0.0024204254,0.11468506,0.06311035,-0.060150146,0.11608887,-0.010093689,-0.0713501,0.007537842,-0.01838684,-0.088012695,0.051483154,0.06958008,-0.023254395]	0	\N	\N	f	t	When Chuck Norris was born, he drove his mom home from the hospital.
12	Chuck Norris's tears cure cancer. Too bad he has never cried.	\N	0	0	0	0	2026-03-31 05:08:24.165637+00	2026-04-01 18:56:49.177+00	[-0.014091492,0.02558899,-0.061523438,0.14331055,0.03527832,0.047973633,0.031311035,0.03955078,-0.06341553,0.016693115,0.036376953,-0.019378662,0.048980713,0.038848877,-0.03866577,-0.011528015,0.07208252,-0.0053138733,-0.07305908,0.014701843,-0.020217896,0.09649658,-0.03756714,-0.06384277,0.103393555,-0.017150879,0.12414551,-0.01687622,0.06903076,0.020980835,0.029785156,-0.058135986,-0.024230957,0.003648758,0.034698486,0.038604736,0.09222412,-0.01701355,-0.03555298,0.02331543,-0.007575989,-0.08526611,0.044830322,0.061645508,-0.009849548,-0.07293701,-0.04147339,-0.057922363,0.032318115,-0.0385437,-0.04046631,-0.011390686,-0.0031909943,0.10064697,0.022857666,0.023025513,-0.0736084,0.018493652,0.021957397,-0.04937744,0.014160156,-0.048706055,-0.017059326,-0.109436035,-0.077697754,-0.023498535,0.021957397,-0.08459473,0.053222656,0.030792236,-0.059295654,0.011993408,0.016571045,0.13244629,-0.010856628,0.020202637,-0.0036773682,0.05014038,0.0021438599,-0.035614014,0.09881592,-0.009864807,0.0034637451,-0.06738281,-0.022644043,-0.046813965,-0.0019836426,0.013076782,-0.074401855,0.027282715,-0.0020942688,0.011436462,-0.0637207,-0.027038574,0.035247803,0.029510498,0.06945801,0.04937744,0.08087158,-0.07348633,-0.0026988983,-0.045196533,-0.02067566,0.029281616,0.011077881,0.15270996,-0.087768555,-0.060333252,-0.046447754,0.123168945,0.011604309,-0.008766174,-0.011383057,-0.06149292,-0.11932373,-0.05267334,-0.06555176,0.03942871,-0.003545761,0.014854431,0.10418701,0.1003418,0.04547119,0.003370285,-0.021270752,0.0009012222,0.024368286,0.08868408,-0.0031967163,-0.06088257,0.05596924,0.00605011,0.01802063,0.020568848,-0.023971558,-0.052703857,-0.07635498,-0.033203125,-0.0132751465,0.08532715,-0.035003662,-0.021072388,-0.002948761,-0.0064582825,0.042907715,-0.016326904,0.0056610107,0.021057129,0.07287598,0.0121536255,-0.019851685,-0.011680603,0.026107788,0.0025253296,-0.04510498,-0.03427124,0.017074585,0.03314209,-0.07104492,0.027359009,0.037353516,0.044128418,-0.115112305,0.0060653687,-0.013267517,0.064575195,0.019683838,0.005077362,-0.014801025,-0.080078125,0.017822266,-0.053100586,0.026992798,-0.061767578,-0.0074882507,0.0018882751,0.06677246,-0.009407043,-0.038482666,0.064697266,0.0018415451,0.034576416,0.054107666,-0.0066337585,-0.01007843,0.061523438,0.0009469986,0.023498535,0.012390137,-0.075805664,-0.015045166,-0.014511108,0.0038604736,0.088134766,-0.04119873,-0.031433105,0.020355225,-0.050567627,-0.0046958923,-0.039520264,-0.0026245117,0.095214844,0.03515625,-0.026473999,-0.01576233,-0.0023765564,0.07312012,0.011482239,-0.024780273,-0.009140015,0.043518066,0.080078125,-0.053466797,-0.021072388,0.017150879,-0.061584473,0.03765869,0.042877197,-0.010215759,-0.0463562,0.010681152,0.043945312,0.06451416,-0.046325684,0.015701294,0.02571106,0.005016327,-0.0059394836,0.013259888,0.09698486,-0.06817627,0.076171875,0.04724121,0.0032844543,-0.037841797,0.0473938,-0.008285522,-0.025772095,0.012878418,-0.009902954,-0.019470215,0.0043411255,-0.029067993,-0.006210327,-0.056915283,-0.0015039444,-0.046569824,-0.08325195,0.058410645,-0.0026168823,-0.0129470825,0.061767578,0.030029297,0.026870728,-0.078308105,0.007797241,-0.021255493,-0.07098389,0.004295349,0.04776001,0.10437012,-0.011161804,-0.015075684,-0.124572754,-0.09527588,0.0075798035,-0.025634766,-0.017837524,0.0847168,0.03314209,0.11694336,0.049224854,0.060333252,-0.06945801,-0.020690918,-0.055358887,0.0031490326,0.024749756,-0.0037708282,0.03262329,-0.027999878,0.058563232,0.0033187866,-0.10003662,0.02722168,-0.02482605,-0.0146484375,0.007698059,0.009788513,-0.090026855,-0.018356323,-0.062683105,0.024551392,0.10723877,-0.10998535,0.01158905,-0.0262146,0.06378174,0.027542114,-0.003458023,-0.004547119,-0.022338867,7.8856945e-05,0.026535034,0.011436462,0.052215576,-0.03930664,-0.07696533,0.11657715,0.086242676,0.0005068779,0.086364746,-0.004760742,-0.004383087,0.032806396,-0.0071258545,-0.032226562,-0.03994751,0.012306213,-0.085876465,0.037109375,0.032226562,0.020370483,0.049804688,-0.039245605,0.057373047,0.15710449,0.033843994,0.080322266,0.046722412,-0.13769531,-0.06945801,-0.021530151,-0.039489746,0.019577026,0.015930176,-0.014640808,0.037841797,-0.034576416,-0.09442139,-0.012039185,0.012283325,-0.013694763,0.04727173,-0.038116455,-0.04748535,0.07501221,-0.002313614,-0.04940796,-0.040130615,0.0098724365,0.15625,-0.0063705444,0.017288208,-0.042419434,0.03491211,-0.05984497,0.028747559,0.047698975,0.07922363,-0.007030487,-0.0031528473,0.02305603,-0.007827759,0.037902832,-0.04937744,-0.06994629,0.032073975,0.025543213,-0.028244019,-0.09631348,0.07220459,0.064208984,-0.012786865,0.016799927,0.08660889,-0.0129776,0.0069847107,0.03375244,-0.06463623,-0.053710938,0.034240723,0.042388916,0.039886475]	0	\N	\N	f	t	Chuck Norris's tears cure cancer. Too bad he has never cried.
9	Chuck Norris once kicked a horse in the chin. Its descendants are known today as giraffes.	\N	0	0	0	0	2026-03-31 05:08:23.545054+00	2026-04-01 18:56:54.08+00	[-0.0030765533,0.088256836,-0.009803772,0.109436035,-0.0033855438,0.16259766,-0.029846191,0.040771484,-0.080078125,0.014419556,-0.0014572144,0.03543091,-0.0033111572,0.027633667,-0.031829834,-0.0053138733,0.013183594,0.027023315,-0.032348633,0.080566406,-0.015716553,0.09918213,0.043029785,-0.04232788,0.06161499,0.011955261,0.023742676,-0.05279541,0.014480591,-0.013786316,0.049591064,-0.02973938,-0.0048561096,0.049621582,-0.072021484,-0.048980713,0.04840088,-0.00737381,-0.07312012,0.013908386,-0.008964539,-0.09674072,0.014022827,0.039916992,0.086120605,-0.03842163,0.022918701,-0.01474762,-0.04788208,0.050811768,-0.044677734,-0.039245605,-0.045776367,-0.005268097,0.02809143,0.072631836,-0.017593384,0.00667572,-0.012054443,-0.03842163,-0.070373535,-0.09899902,0.10223389,-0.02810669,-0.056640625,-0.0020122528,-0.042022705,0.004787445,0.009773254,0.031051636,0.050933838,0.008857727,-0.057891846,0.13171387,0.0037612915,-0.02230835,-0.009971619,0.09277344,0.051940918,0.017440796,0.099609375,0.04840088,-0.016448975,-0.04714966,0.0635376,0.015838623,-0.0068511963,0.052093506,-0.03451538,0.012435913,-0.02281189,0.058898926,-0.06124878,-0.058135986,-0.020721436,0.02027893,0.017028809,0.013618469,0.045654297,-0.022750854,0.015731812,0.0049476624,0.0028266907,0.019760132,-0.0028419495,0.07421875,-0.049743652,0.042755127,0.013801575,-0.0038223267,0.004055023,-0.10296631,-0.00223732,0.019363403,-0.019302368,0.021499634,0.038482666,0.06878662,0.05456543,0.070007324,0.017318726,0.05142212,-0.05142212,-0.053741455,-0.025970459,0.0026454926,-0.061767578,0.099731445,-0.02758789,-0.08239746,0.05380249,-0.020080566,0.049987793,-0.026397705,-0.0005726814,-0.076660156,-0.015342712,-0.12585449,-0.020385742,0.01625061,-0.054779053,-0.0119018555,-0.03817749,-0.046295166,0.08111572,0.006290436,-0.036102295,0.046539307,-0.018966675,-0.0413208,0.057525635,0.009628296,0.03829956,-0.029846191,-0.097229004,0.038238525,-0.036499023,-0.07952881,0.035980225,0.008071899,-0.025619507,0.06109619,-0.0040359497,0.053985596,-0.004901886,0.026000977,-0.005455017,-0.03265381,-0.013000488,-0.071777344,-0.0034637451,0.012939453,0.026733398,-0.08605957,-0.021438599,-0.03286743,-0.027572632,-0.017562866,-0.011199951,-0.007835388,0.006298065,0.13598633,-0.04937744,0.06036377,-0.025009155,0.06677246,0.0052223206,-0.022003174,0.048950195,0.06359863,-0.008720398,0.0036258698,-0.015586853,0.03225708,-0.01676941,-0.047454834,0.059570312,-0.1340332,0.0069274902,-0.024017334,0.010597229,0.06341553,-0.014175415,-0.06085205,0.04574585,0.03390503,0.025314331,-0.018615723,-0.022262573,-0.05718994,0.063964844,-0.015411377,-0.02267456,-0.0019054413,-0.03414917,0.00027680397,0.0129852295,0.062286377,-0.121032715,-0.04071045,-0.009346008,0.024749756,0.04840088,0.004371643,0.034088135,-0.0032863617,-0.06524658,-0.038513184,0.020263672,0.049194336,-0.048034668,0.015045166,0.035308838,-0.13122559,-0.058563232,-0.01802063,-0.022094727,-0.04714966,-0.021759033,0.0023918152,0.010696411,-0.0036792755,0.02381897,0.04888916,-0.028747559,0.073791504,-0.012397766,-0.0029621124,0.06756592,0.035308838,0.03488159,0.068237305,0.094055176,0.025772095,-0.06890869,-0.005996704,-0.04876709,-0.15588379,0.010040283,0.07684326,0.04534912,-0.059020996,-0.08190918,0.040008545,-0.13928223,-0.03692627,-0.050689697,-0.12854004,-0.007762909,0.10473633,0.0524292,0.06915283,-0.027908325,-0.08984375,-0.051483154,-0.06976318,-0.008659363,-0.04257202,-0.029510498,-0.037902832,0.057678223,0.034240723,0.059570312,-0.06567383,-0.0061683655,-0.040863037,0.023025513,-0.05621338,0.099609375,-0.047607422,-0.016937256,-0.038635254,-0.010749817,0.06591797,0.008071899,0.008018494,-0.053985596,0.0029392242,0.05218506,-0.08404541,0.006515503,0.03277588,0.019546509,-0.034179688,-0.07342529,0.0050582886,0.051208496,0.032409668,0.059051514,0.035736084,-0.021942139,0.032409668,-0.035003662,-0.060028076,-0.042022705,-0.01914978,0.040740967,-0.027755737,0.052459717,0.03353882,0.011199951,0.068359375,0.002576828,0.08081055,-0.05630493,-0.03375244,0.004600525,-0.040649414,0.028823853,0.013793945,0.014350891,-0.10797119,-0.04107666,0.083984375,0.034423828,0.0039787292,-0.09295654,0.02218628,0.06036377,-0.15551758,-0.07751465,-0.044525146,0.049438477,0.038116455,-0.04071045,-0.025100708,0.04812622,0.042541504,-0.0715332,-0.026397705,0.0107040405,0.091308594,0.010749817,0.027389526,0.007736206,-0.003709793,-0.06866455,0.017440796,-0.026824951,0.050598145,-0.070617676,0.059906006,-0.010147095,-0.03591919,-0.0057640076,-0.05633545,-0.070373535,-0.005458832,0.06427002,0.015365601,-0.075805664,0.036132812,0.006011963,-0.0017986298,0.030563354,0.113586426,0.021957397,-0.042907715,-0.029937744,-0.06555176,-0.107421875,0.044921875,0.086364746,0.016296387]	0	\N	\N	f	t	Chuck Norris once kicked a horse in the chin. Its descendants are known today as giraffes.
11	Chuck Norris can slam a revolving door.	\N	0	0	0	0	2026-03-31 05:08:24.025471+00	2026-04-01 18:56:56.177+00	[-0.027999878,0.13049316,-0.04434204,-0.0038661957,0.022888184,0.15112305,0.01083374,0.040130615,-0.059173584,-0.028305054,-0.007698059,0.019561768,-0.0035591125,0.11663818,-0.03845215,-0.025817871,-0.010749817,0.033691406,-0.050354004,0.0635376,-0.014373779,0.08526611,0.017623901,-0.03869629,0.021118164,0.076171875,0.07635498,0.002090454,0.07458496,0.03869629,0.070739746,-0.03717041,-0.041748047,0.04220581,-0.03717041,-0.0007123947,0.0069236755,0.04031372,-0.035736084,-0.021865845,-0.030532837,-0.058410645,0.030838013,-0.010848999,0.03262329,0.012374878,-0.072631836,-0.05734253,0.0262146,0.017578125,-0.028137207,-0.028121948,0.02999878,-0.0016098022,0.013000488,-0.050445557,-0.04107666,-0.041870117,0.013130188,-0.032287598,-0.008331299,-0.10223389,0.0065193176,-0.036468506,-0.042236328,-0.068481445,-0.0023956299,0.01612854,0.08880615,0.012901306,-0.015220642,0.016067505,-0.068237305,0.058654785,-0.016616821,0.0019569397,0.021102905,-0.0068740845,0.00762558,0.030212402,0.027557373,-0.008407593,0.025619507,-0.016036987,-0.045074463,0.054382324,-0.031066895,0.06817627,-0.012435913,-0.0078048706,-0.011276245,0.04626465,-0.0009150505,-0.064453125,0.10839844,0.078125,0.051361084,0.013679504,0.05517578,0.024383545,0.033813477,-0.02746582,0.04727173,0.007534027,0.074035645,0.121032715,-0.03036499,-0.022125244,-0.09649658,-0.009712219,-0.0012903214,-0.10015869,0.011146545,-0.024749756,-0.035247803,0.0022125244,0.092285156,0.06518555,-0.021560669,0.0049362183,0.08099365,0.031555176,-0.023147583,-0.04171753,-0.010124207,0.0035381317,-0.041168213,0.05706787,-0.027938843,0.014373779,-0.0005888939,-0.042816162,0.023239136,-0.050567627,-0.017211914,0.05090332,-0.11340332,-0.07635498,-0.03164673,0.058044434,-0.016357422,0.020843506,-0.046203613,0.031677246,-0.00063085556,-0.07543945,-0.01335144,-0.013710022,0.043945312,0.025802612,0.010360718,-0.0029392242,0.015487671,-0.05557251,-0.01802063,0.049560547,0.029342651,0.051513672,0.025848389,0.08660889,5.197525e-05,-0.020507812,-0.11541748,0.040100098,0.004634857,0.06933594,0.073791504,0.045898438,-0.02760315,-0.0085372925,0.045532227,0.012565613,0.059020996,-0.052703857,0.058288574,0.025314331,-0.023773193,-0.035461426,0.01586914,0.051635742,-0.033569336,0.085754395,0.06506348,-0.0670166,-0.024871826,-0.0007901192,0.02029419,0.0012569427,0.038085938,0.01826477,-0.06329346,0.0065956116,-0.06665039,0.004966736,-0.017715454,-0.047698975,0.08679199,-0.050750732,0.0463562,-0.06994629,-0.043914795,0.02746582,-0.0119018555,-0.10925293,-0.003376007,0.03491211,0.06512451,-0.007980347,-0.040527344,-0.008842468,0.061767578,-0.009841919,0.02519226,0.0014724731,-0.0012712479,-0.03189087,0.17651367,-0.011856079,-0.08111572,-0.046051025,0.012031555,0.031402588,0.0011014938,-0.0062294006,0.04168701,0.11755371,0.010322571,-0.015945435,0.07543945,0.095214844,-0.033416748,0.033996582,0.03756714,-0.0703125,-0.029586792,0.08496094,-0.020584106,-0.06707764,0.037597656,0.026657104,-0.030944824,-0.016082764,0.050476074,-0.02394104,-0.054473877,0.016967773,-0.05154419,-0.026290894,0.0034999847,0.035949707,0.029907227,0.04525757,0.030899048,0.026870728,-0.042510986,-0.0015459061,-0.089416504,-0.09899902,-0.049835205,0.053649902,0.06689453,-0.028747559,-0.01234436,-0.0140686035,-0.085998535,0.057678223,-0.03074646,-0.01864624,0.030166626,0.04736328,0.08068848,0.0077781677,-0.027069092,-0.0014467239,-0.0074653625,-0.09222412,0.06604004,-0.05026245,0.046051025,-0.016616821,-0.026123047,0.073791504,-0.0028686523,-0.1184082,-0.0018863678,-0.04458618,-0.031402588,0.033813477,0.0748291,-0.0769043,-0.049743652,-0.064941406,-0.049957275,0.0680542,-0.068603516,-0.0041656494,-0.009735107,0.00390625,0.011222839,-0.032165527,0.036132812,0.064208984,0.022781372,0.057434082,-0.057617188,0.06335449,0.06097412,0.0036830902,0.043670654,-0.025634766,-0.054656982,0.097595215,-0.024749756,-0.08178711,-0.122680664,-0.030700684,0.02909851,-0.024261475,-0.012550354,-0.00497818,0.065979004,0.09436035,0.07043457,-0.029815674,0.011505127,0.086364746,0.11968994,0.051239014,0.07128906,-0.007701874,-0.0077209473,-0.105895996,-0.05392456,-0.05178833,0.048309326,0.041809082,-0.008369446,0.0031471252,-0.0020122528,-0.0703125,-0.05267334,0.018127441,-0.0039711,0.085876465,-0.085998535,0.036743164,0.0032444,-0.03164673,-0.0014123917,-0.004421234,-0.08294678,0.050811768,-0.11608887,0.059448242,-0.031158447,0.0063972473,-0.038391113,-0.011756897,-0.013755798,0.03894043,-0.046295166,0.088134766,-0.0037155151,0.02746582,-0.03564453,-0.0059814453,-0.06707764,-0.044769287,0.105529785,0.049316406,0.010803223,0.044036865,0.04840088,0.05142212,0.0234375,0.14440918,0.0037612915,-0.05029297,0.12451172,-0.07470703,-0.06951904,0.047790527,0.017501831,-0.04486084]	0	\N	\N	f	t	Chuck Norris can slam a revolving door.
15	Chuck Norris can build a snowman out of rain.	\N	0	0	0	0	2026-03-31 05:08:24.812356+00	2026-04-01 18:56:58.077+00	[-0.012390137,0.03692627,-0.086364746,0.0016336441,0.019165039,0.030349731,-0.041259766,0.0037956238,-0.050476074,-0.036621094,-0.05480957,0.097961426,0.015174866,0.03665161,-0.05734253,0.010314941,0.006965637,-0.0118637085,-0.039916992,0.026138306,-0.033935547,0.047851562,0.0042037964,-0.07342529,0.064453125,0.068847656,0.029830933,0.06817627,0.12384033,0.018218994,0.04196167,-0.031341553,-0.04547119,0.015487671,0.08325195,-0.021621704,0.007030487,-0.02407837,-0.05731201,0.014411926,0.009506226,-0.091674805,0.04046631,0.0090789795,0.0541687,-0.00844574,-0.01008606,-0.009895325,0.012382507,0.0026550293,-0.0836792,0.03036499,-0.004425049,0.00032925606,0.0037174225,-0.027679443,-0.081970215,-0.0054397583,0.0034389496,0.015419006,0.011947632,-0.099243164,-0.019439697,-0.018707275,-0.03866577,-0.026168823,0.0496521,-0.04525757,0.020355225,0.02708435,-0.020751953,-0.003276825,0.039764404,0.024261475,-0.027816772,0.030883789,-0.043640137,-0.0049209595,0.024154663,-0.032348633,0.06573486,-0.009025574,0.028305054,-0.07727051,-0.07952881,0.040222168,-0.018737793,0.022109985,-0.03213501,-0.022277832,0.059936523,0.08050537,0.008125305,-0.08685303,0.08843994,-0.0019207001,0.026565552,0.049926758,0.082214355,-0.02734375,0.06829834,-0.038513184,0.049346924,-0.039642334,0.04525757,0.12030029,-0.081604004,0.0045547485,-0.101745605,0.016296387,-0.021133423,-0.07611084,0.009757996,-0.041931152,-0.030548096,0.018463135,0.0014429092,0.0736084,-0.038085938,0.042297363,0.17468262,0.04525757,0.03390503,-0.012557983,0.0033721924,0.00071525574,-0.021148682,0.025253296,-0.045318604,-0.00081062317,-0.02885437,0.045654297,0.046295166,-0.006088257,0.012802124,-0.03137207,-0.111694336,-0.09503174,-0.03463745,0.04840088,-0.011177063,-0.0039520264,-0.0206604,0.037475586,0.054138184,-0.05734253,0.024414062,-0.0056381226,0.042877197,0.0053749084,0.076660156,-0.07861328,0.032409668,-0.019714355,-0.008087158,-0.0035591125,0.0463562,0.03225708,0.019897461,0.011131287,0.029937744,0.00579834,-0.04147339,0.05871582,0.0013341904,0.0871582,0.0680542,0.011520386,-0.01335144,-0.10797119,0.006828308,0.025421143,0.028823853,-0.031204224,0.028945923,0.06890869,-0.018920898,-0.021621704,0.01939392,0.047210693,-0.017425537,0.05722046,0.06488037,-0.11755371,-0.018173218,0.0496521,0.005657196,0.060058594,0.12371826,0.04284668,-0.08111572,0.026977539,0.044647217,0.005970001,0.048614502,-0.09576416,0.06427002,-0.031921387,0.08630371,-0.0021972656,-0.023025513,0.06451416,0.008880615,-0.04522705,-0.05670166,0.031951904,0.034576416,0.03036499,-0.09307861,-0.027954102,0.05529785,0.016464233,-0.04699707,-0.017807007,0.014389038,0.03375244,0.036468506,0.034576416,-0.15148926,-0.007827759,-0.06713867,-0.024398804,-0.009635925,-0.015388489,-0.021133423,0.05633545,0.018829346,-0.04446411,0.088378906,0.07562256,-0.03881836,0.036254883,-0.026428223,-0.013160706,-0.089904785,0.1182251,-0.08673096,0.0049934387,0.027267456,0.04348755,-0.016418457,0.018753052,0.012207031,0.060058594,-0.044128418,0.059387207,-0.064331055,-0.01108551,0.044769287,-0.03427124,0.08514404,0.013679504,-0.042816162,0.09552002,-0.064819336,-0.06274414,-0.039245605,-0.07342529,0.026473999,-0.010093689,-0.032440186,0.0007581711,-0.07159424,-0.052459717,-0.066589355,0.020187378,-0.066101074,-0.017211914,0.080200195,0.054718018,0.07647705,0.0602417,-0.041931152,-0.048919678,-0.004760742,0.003921509,0.06842041,0.015853882,-0.035583496,0.008544922,-0.030166626,-0.029373169,0.023605347,-0.11480713,-0.03918457,-0.05670166,-0.080200195,0.046813965,0.043395996,-0.12072754,0.017364502,-0.05291748,-0.013092041,0.06567383,-0.08001709,2.104044e-05,-0.08001709,0.053466797,0.042022705,-0.0119018555,-0.009498596,0.023147583,0.027435303,0.07128906,-0.008712769,0.051818848,-0.007129669,-0.07867432,0.058654785,0.0056495667,-0.04360962,0.06304932,-0.060913086,-0.07714844,-0.041534424,-0.072387695,0.03543091,-0.031097412,-0.0020866394,-0.0021839142,0.068847656,0.09631348,0.02015686,-0.03643799,-0.062927246,0.08239746,0.1138916,-0.026611328,-0.012184143,-0.01928711,-0.07891846,-0.0074157715,-0.07232666,0.008842468,0.07635498,-0.04611206,-0.019699097,-0.04449463,0.015510559,-0.09503174,-0.0032196045,-0.020523071,-0.00957489,0.01499176,-0.0791626,-0.054229736,0.006793976,-0.018218994,-0.027389526,0.034423828,-0.005592346,0.072509766,-0.12475586,-0.010658264,0.006298065,0.018829346,0.025726318,-0.014945984,-0.0017213821,0.0049934387,-0.014434814,0.07873535,-0.0021839142,-0.016082764,-0.04135132,0.013442993,-0.07232666,0.08441162,0.0022296906,-0.0055351257,-0.109558105,0.1071167,0.033477783,0.028121948,0.033325195,0.073791504,-0.0025138855,-0.0062179565,0.08026123,-0.060699463,-0.0770874,0.047668457,0.07867432,-0.05670166]	0	\N	\N	f	t	Chuck Norris can build a snowman out of rain.
19	Chuck Norris does not wear a watch. He decides what time it is.	\N	0	0	0	0	2026-03-31 05:08:25.405975+00	2026-04-01 18:57:01.077+00	[-0.042510986,0.10015869,-0.066833496,-0.038909912,0.035949707,0.04336548,0.068237305,-0.019348145,-0.031982422,-0.06500244,-0.034851074,0.06365967,0.0036334991,0.048431396,-0.022216797,0.019515991,-0.08691406,-0.026321411,-0.039245605,0.071777344,-0.057525635,0.059661865,-0.010932922,-0.048858643,0.04348755,0.041046143,0.044403076,0.06677246,0.04647827,0.0736084,0.041870117,-0.020767212,0.0010843277,0.028839111,0.005306244,0.004470825,0.117492676,-0.017654419,-0.070373535,0.016448975,-0.096069336,-0.053253174,0.012992859,-0.014175415,0.0067710876,-0.07714844,-0.04421997,-0.0008773804,0.028244019,0.046081543,-0.07366943,-0.0039749146,-0.066101074,0.025115967,0.00091171265,-0.06604004,-0.057800293,0.011062622,0.04953003,0.05303955,0.004447937,-0.094177246,-0.014755249,0.03845215,-0.033111572,-0.060058594,0.016845703,-0.003326416,0.034484863,0.012542725,-0.07122803,0.019134521,0.0070991516,0.060272217,-0.016983032,0.10687256,-0.03692627,0.04269409,0.0413208,0.15307617,0.068359375,-0.006126404,-0.05166626,0.041015625,0.034179688,0.03463745,-0.004802704,0.022872925,-0.042633057,-0.08123779,-0.016113281,0.0043411255,-0.0178833,-0.048309326,-0.0061798096,0.015319824,0.06561279,0.14355469,0.11218262,-0.021209717,0.0069999695,-0.038208008,0.038726807,0.015625,-0.009796143,0.16320801,-0.03149414,0.012336731,-0.08111572,0.02168274,0.010765076,-0.0670166,-0.053344727,0.019088745,-0.019897461,-0.03994751,0.008712769,0.053253174,0.07672119,0.031707764,0.099853516,0.008407593,0.012619019,0.040863037,-0.023742676,0.07611084,-0.07879639,0.05621338,-0.060455322,-0.056274414,-0.0023174286,-0.11236572,0.021530151,-0.04449463,-0.038726807,-0.048431396,-0.0690918,-0.0029315948,-0.1083374,0.11480713,0.008926392,0.0052833557,-0.040924072,0.014587402,0.013763428,0.0016565323,-0.035003662,0.0075569153,0.020462036,0.0045928955,0.01234436,-0.041259766,0.0052490234,0.012535095,0.006839752,0.09069824,0.10192871,-0.04812622,0.009925842,0.14086914,0.053253174,0.067871094,-0.11419678,0.055908203,-0.07647705,0.051574707,0.07354736,-0.081604004,7.891655e-05,0.000831604,-0.005748749,-0.014984131,0.07537842,-0.06750488,0.049835205,0.041229248,-0.0029525757,0.026916504,-0.052825928,0.041503906,0.017150879,0.006526947,0.004764557,-0.03729248,0.05291748,0.04284668,-0.006439209,0.03137207,0.06549072,0.0031986237,-0.01285553,0.05911255,0.04345703,0.029632568,-0.062561035,0.01776123,0.040985107,-0.054840088,-0.0015640259,-0.056671143,-0.028076172,0.13317871,0.014434814,-0.1204834,0.028762817,0.03643799,0.0087509155,0.004901886,-0.016082764,0.036315918,0.038269043,-0.0026721954,0.0063934326,-0.06921387,-0.044647217,-0.033050537,0.060028076,-0.105285645,-0.10974121,-0.07873535,-0.023468018,0.08703613,0.014511108,0.006088257,-0.02571106,-0.0018024445,0.08227539,0.023086548,-0.030136108,0.12133789,-0.020385742,0.053863525,0.050964355,-0.0024662018,-0.0046577454,0.027526855,-0.064575195,-0.027236938,-0.026138306,0.046813965,-0.039733887,-0.06512451,-0.09442139,-0.011436462,-0.09869385,-0.018966675,-0.036712646,0.0016813278,-0.026016235,0.009460449,0.036621094,0.032836914,-0.03503418,0.0009651184,-0.07647705,0.015167236,-0.022491455,-0.015472412,0.027389526,0.070617676,0.01902771,-0.04196167,0.0026855469,-0.03161621,-0.08258057,0.040405273,-0.045684814,-0.10913086,0.010429382,-0.010795593,0.07623291,-0.019760132,-0.049468994,-0.0074424744,-0.045684814,-0.047790527,-0.0073165894,-0.009391785,-0.053253174,0.020309448,0.020065308,0.00983429,-0.007659912,-0.026397705,0.018600464,-0.015060425,0.0021953583,0.101379395,0.08276367,-0.09564209,0.041168213,-0.0030899048,0.023712158,0.04800415,-0.07739258,-0.06274414,-0.011009216,-0.013946533,0.01689148,0.007858276,0.014953613,0.032226562,-0.01727295,0.0011062622,-0.071777344,0.054870605,-0.027175903,0.0129776,0.06439209,-0.01777649,-0.06161499,0.0925293,-0.00756073,-0.042053223,0.035614014,-0.041748047,-0.016098022,0.070373535,0.008453369,-0.082214355,0.01777649,-0.008880615,0.040039062,0.0025691986,-0.016220093,0.06939697,0.1463623,0.013008118,0.04272461,0.022338867,-0.07849121,-0.0869751,-0.025848389,0.03274536,0.035125732,0.048553467,0.006126404,-0.02116394,0.0085372925,-0.018875122,-0.042419434,-0.005760193,-0.037261963,0.0061912537,-0.019943237,-0.039489746,-0.019088745,-0.08026123,-0.0049324036,-0.001077652,0.016357422,0.030090332,-0.014961243,-0.046661377,-0.07897949,0.036834717,0.0034008026,0.044128418,-0.055145264,0.051483154,-0.08148193,0.07501221,-0.031234741,-0.030929565,-0.04071045,-0.06774902,-0.020095825,-0.0090408325,-0.042022705,-0.0027313232,-0.019973755,0.042419434,0.0010986328,0.036621094,0.0014591217,0.06756592,0.0017518997,-0.018310547,0.04800415,0.01864624,-0.03149414,0.03152466,0.11682129,-0.09136963]	0	\N	\N	f	t	Chuck Norris does not wear a watch. He decides what time it is.
23	Chuck Norris once won a staring contest against a blind man, twice.	\N	0	0	0	0	2026-03-31 05:08:25.797702+00	2026-04-01 18:57:02.977+00	[-0.046539307,0.05758667,-0.027175903,0.021484375,0.033050537,0.08929443,0.030166626,0.033447266,-0.069885254,-0.010482788,0.04660034,0.021820068,0.06732178,0.03970337,0.016723633,0.02079773,-0.062683105,-0.010444641,-0.054626465,0.04837036,-0.05807495,0.021499634,0.0463562,0.010414124,0.06112671,0.011398315,0.06384277,-0.01197052,0.117492676,0.053771973,0.0101623535,-0.01763916,-0.052093506,0.025894165,-0.004924774,0.0234375,0.0715332,0.0043563843,-0.08917236,-0.0006380081,0.039215088,-0.089660645,0.06488037,0.037200928,0.0859375,-0.04071045,0.022033691,-0.046875,-0.009719849,-0.020339966,-0.043640137,0.012023926,-0.00390625,0.10467529,0.042175293,-0.015106201,-0.03982544,0.0068855286,-0.03616333,0.004749298,0.019195557,-0.03137207,0.030410767,-0.020904541,-0.053527832,-0.055633545,0.010093689,0.014228821,0.05368042,0.058441162,-0.008041382,-0.018493652,0.01184082,0.09063721,0.020050049,0.030151367,-0.006614685,0.0803833,0.056365967,0.046325684,0.07208252,-0.01260376,-0.019439697,-0.014984131,-0.006198883,0.038848877,-0.018753052,0.036193848,-0.03137207,0.006416321,-0.06689453,0.03741455,0.017669678,-0.1217041,0.04498291,0.069885254,0.023239136,-0.050048828,0.107666016,-0.010345459,0.046539307,0.028656006,0.033721924,0.056488037,-0.031921387,0.1652832,0.03881836,0.023208618,-0.004798889,0.021697998,0.011184692,-0.05834961,0.018112183,-0.01423645,-0.026641846,0.00605011,0.050598145,-0.008056641,0.044921875,0.045532227,0.14440918,0.028198242,-0.010467529,-0.041168213,0.037384033,-0.045562744,0.010787964,-0.004676819,0.0102005005,-0.0670166,0.023651123,-0.040893555,0.076171875,-0.039916992,-0.08428955,-0.023727417,-0.097717285,-0.041229248,-0.04473877,0.046661377,-0.039001465,-0.055603027,-0.018737793,0.0076408386,0.07745361,0.010131836,0.021713257,0.026168823,0.0027217865,-0.024276733,-0.01977539,0.0012369156,0.0019025803,-0.0040359497,-0.12634277,0.0036334991,0.011009216,0.01109314,0.016357422,0.016143799,0.054138184,-0.04611206,0.015838623,0.034240723,0.007045746,0.09710693,0.091430664,0.024261475,0.009277344,-0.044921875,0.053955078,0.05718994,0.10205078,-0.12976074,0.030960083,0.013427734,-0.017074585,-0.010955811,-0.03262329,-0.03189087,-0.0043411255,-0.023117065,0.09185791,0.038726807,-0.03086853,0.042663574,-0.022598267,-0.03793335,0.08496094,-0.06008911,0.021438599,0.027496338,-0.03515625,0.059509277,-0.0007176399,-0.069885254,0.035491943,-0.045166016,-0.013046265,-0.022140503,-0.0020484924,0.007820129,-0.062042236,0.004081726,0.039245605,0.008522034,0.08947754,0.051605225,-0.038116455,0.043548584,0.059936523,0.0062332153,0.010887146,0.0032253265,-0.048919678,-0.076049805,0.044921875,-0.016998291,-0.09460449,0.0052223206,0.039489746,0.053100586,0.115600586,0.0026340485,0.05847168,0.037963867,-0.0004916191,0.03805542,0.04815674,-0.011138916,-0.0044937134,-0.011894226,0.042297363,-0.022766113,0.03845215,0.013427734,-0.017227173,-0.065979004,0.0053520203,0.0065956116,0.027389526,0.017608643,-0.0012845993,0.02027893,-0.05545044,-0.020050049,-0.07287598,0.012199402,-0.022827148,-0.005832672,0.029830933,0.0093307495,-0.024734497,0.020751953,-0.035491943,0.010650635,0.031433105,-0.14660645,0.04083252,-0.015426636,-0.03024292,0.047821045,-0.09484863,-0.107177734,-0.12072754,0.0020694733,-0.06341553,-0.032440186,0.025299072,0.07397461,0.06829834,0.03994751,-0.029434204,0.037719727,-0.024459839,-0.100097656,0.062408447,0.011459351,-0.022628784,-4.4703484e-06,-0.02557373,0.076293945,-0.0028495789,-0.13574219,0.019683838,-0.00053596497,-0.030227661,-0.010231018,0.02406311,-0.100097656,-0.04498291,-0.14489746,0.09442139,0.13977051,-0.047058105,-0.08215332,-0.037628174,-0.023513794,0.0362854,-0.048980713,0.027664185,0.016281128,-0.03842163,0.10015869,-0.05706787,0.10418701,0.0042648315,-0.0053901672,0.10974121,-0.027801514,-0.06335449,0.056518555,-0.025772095,-0.0026359558,-0.06439209,-0.04550171,-0.0074272156,0.06652832,-0.078186035,-0.023269653,0.03778076,0.11956787,0.03086853,0.051208496,0.015388489,0.036010742,0.0262146,0.014503479,0.029678345,0.00712204,-0.04876709,-0.045440674,-0.061309814,-0.038269043,-0.015808105,0.012802124,-0.07543945,0.039489746,-0.06890869,-0.052459717,-0.1274414,0.010536194,-0.047546387,-0.009796143,-0.020935059,-0.0574646,0.027786255,-0.015274048,-0.0048446655,-0.024795532,-0.035980225,0.070129395,-0.008033752,-0.0034484863,-0.033416748,0.06500244,-0.15026855,0.06878662,0.02696228,0.07385254,-0.050323486,0.039794922,-0.016998291,-0.006816864,-0.020187378,-0.06756592,-0.038391113,-0.00054597855,0.057739258,0.023239136,-0.014144897,0.12121582,-0.0063056946,-0.0008368492,-0.00440979,0.109313965,-0.012702942,-0.0027046204,-0.025619507,-0.047698975,-0.04824829,-0.004047394,0.04360962,-0.031280518]	0	\N	\N	f	t	Chuck Norris once won a staring contest against a blind man, twice.
22	Chuck Norris does not wear sunglasses because the sun wears Chuck Norris glasses.	\N	0	0	0	0	2026-03-31 05:08:25.714156+00	2026-04-01 18:57:05.677+00	[-0.029907227,0.030807495,-0.032348633,0.034729004,0.10681152,0.07861328,0.0793457,-0.018600464,-0.120910645,-0.076538086,-0.02305603,0.09472656,0.0031108856,0.045959473,-0.026657104,0.054595947,-0.020889282,-0.045166016,-0.0859375,0.04534912,0.016464233,0.11242676,0.02859497,-0.0385437,0.014038086,0.039031982,0.09197998,0.08111572,0.107299805,0.064086914,-0.03137207,-0.006336212,-0.02809143,-0.016586304,0.027664185,-0.009490967,0.01007843,0.015670776,-0.014541626,0.043701172,0.0021400452,-0.05670166,0.048034668,0.006126404,0.03692627,-0.03286743,0.021438599,-0.061920166,0.0524292,-0.007904053,-0.054992676,-0.054595947,-0.048950195,0.07055664,-0.017913818,0.0012140274,-0.07702637,0.0020618439,-0.010063171,-0.014625549,0.041168213,-0.05621338,-0.02255249,0.027740479,-0.09814453,-0.046844482,0.061676025,-0.007221222,-0.031799316,0.101135254,0.006187439,-0.053497314,0.0104904175,0.06262207,0.004348755,0.07421875,-0.011405945,-0.0019454956,0.05883789,0.049713135,0.08074951,0.017837524,0.0016412735,0.028289795,-0.0047912598,0.0018844604,0.021850586,0.030151367,-0.01600647,-0.0034484863,-0.0025310516,-0.038085938,-0.027557373,-0.08331299,-0.032684326,0.049194336,0.078430176,0.053985596,0.09326172,-0.087646484,-0.02607727,-0.042388916,0.03869629,0.07940674,0.036621094,0.11352539,-0.025726318,0.008628845,-0.012802124,0.04827881,0.0046844482,-0.07147217,0.031066895,0.01322937,-0.042816162,0.079833984,0.005809784,0.08050537,0.013389587,-0.0040626526,0.10559082,0.03656006,0.032806396,-0.012580872,-0.015853882,0.06695557,0.020370483,0.013618469,-0.081604004,-0.050720215,0.036071777,-0.097595215,0.0005021095,-0.044799805,0.013435364,-0.054595947,-0.13427734,-0.047821045,-0.04901123,0.041992188,-0.04925537,0.014572144,-0.025222778,-0.022399902,0.042755127,-0.012084961,0.04852295,-0.0012979507,0.12176514,0.029022217,0.0055618286,-0.058166504,0.017547607,0.024261475,-0.027297974,-0.03503418,0.11706543,0.0048713684,0.054107666,0.09173584,0.12359619,0.07397461,-0.060821533,0.006702423,-0.057128906,0.01826477,0.06414795,-0.04534912,-0.0053253174,-0.033294678,-0.04522705,0.022201538,0.07775879,-0.051239014,0.023834229,0.027954102,-0.029296875,-0.019744873,-0.01184082,0.065979004,0.054748535,0.023788452,0.08203125,0.0073623657,-0.034851074,-0.014472961,-0.036956787,0.0031337738,0.028457642,-0.031951904,-0.04345703,0.00674057,-0.009941101,0.095825195,-0.10345459,-0.04977417,0.04559326,-0.03668213,-0.04611206,-0.05593872,-0.01235199,0.034240723,0.047912598,0.018310547,0.014076233,0.0002399683,0.064575195,0.035461426,-0.02166748,0.054473877,0.06112671,0.043701172,0.01676941,-0.015296936,0.0029563904,-0.052337646,0.046875,-0.015571594,-0.06390381,-0.009002686,-0.020614624,0.033813477,0.09313965,0.013412476,0.009490967,0.06414795,0.10345459,0.024871826,-0.015136719,0.14160156,-0.06970215,0.043426514,0.012207031,-0.06585693,-0.03414917,-0.033721924,0.0049095154,-0.0181427,-0.036376953,0.024917603,-0.056884766,-0.0022659302,-0.012886047,-0.034484863,-0.06677246,-0.015670776,-0.05050659,0.034332275,0.032409668,-0.013626099,0.027557373,0.09436035,-0.012397766,-0.013931274,-0.05593872,0.023910522,-0.00084257126,-0.0345459,0.022628784,0.08660889,-0.034240723,-0.03466797,-0.020645142,-0.061798096,-0.081604004,0.04208374,-0.07421875,-0.08898926,0.08618164,0.036834717,0.1026001,0.05947876,-0.030578613,0.038909912,-0.05014038,-0.09350586,-0.025604248,-0.02482605,-0.05050659,0.004512787,0.021743774,0.015403748,-0.03152466,0.0025844574,0.015853882,-0.030639648,-0.034820557,0.010215759,0.015129089,-0.07421875,0.03942871,-0.02482605,0.047332764,0.07611084,-0.099975586,0.028533936,-0.019195557,0.007133484,-0.0038909912,-0.029327393,0.006549835,0.08502197,-0.042144775,0.06286621,-0.08087158,0.046142578,0.030883789,0.018188477,0.0871582,0.026016235,-0.13244629,0.012580872,-0.047546387,-0.025985718,-0.034332275,-0.0118255615,-0.02178955,-0.0046920776,-0.028884888,-0.07946777,-0.021133423,0.111206055,0.025650024,0.00806427,-0.01979065,0.07141113,0.09362793,-0.00088500977,0.039764404,0.017150879,-0.082336426,-0.09814453,-0.06304932,-0.05267334,0.068237305,-0.030334473,-0.051605225,-0.0070877075,-0.018829346,-0.16320801,0.02758789,0.07519531,0.014099121,-0.018508911,-0.005420685,-0.06829834,-0.031402588,-0.02798462,-0.03741455,0.022491455,0.026565552,0.061767578,-0.013923645,-0.07244873,-0.03225708,0.002664566,-0.017288208,0.0031700134,-0.050201416,0.053527832,-0.003768921,0.038085938,0.01940918,-0.028198242,0.0051841736,-0.09069824,0.0035438538,-0.012016296,0.001953125,-0.018066406,-0.038330078,0.049713135,-0.049591064,0.010391235,0.041503906,0.13256836,0.023788452,-0.03656006,0.010231018,-0.042633057,-0.07318115,0.06506348,0.032562256,-0.0289917]	0	\N	\N	f	t	Chuck Norris does not wear sunglasses because the sun wears Chuck Norris glasses.
28	Chuck Norris once kicked a horse in the chin and its legs became giraffes.	\N	0	0	0	0	2026-03-31 05:08:26.559505+00	2026-04-01 18:57:07.4+00	[-0.016845703,0.078125,-0.0040664673,0.08996582,0.0051994324,0.13500977,-0.016799927,0.058532715,-0.08178711,0.026931763,0.012832642,0.03250122,-0.011680603,0.03741455,-0.011558533,0.0028362274,0.003232956,0.045654297,-0.017578125,0.09869385,-0.02709961,0.10064697,0.04336548,-0.04598999,0.0637207,0.018554688,0.0519104,-0.084228516,0.02960205,-0.026184082,0.04083252,-0.028289795,0.003566742,0.031341553,-0.04800415,-0.039733887,0.016036987,-0.0023727417,-0.06842041,-0.0067329407,-0.027633667,-0.11010742,0.018081665,0.045959473,0.08306885,-0.0209198,0.046051025,-0.0072364807,-0.052703857,0.04751587,-0.054595947,-0.005317688,-0.030426025,0.014183044,0.040039062,0.05444336,-0.0184021,-0.031555176,-0.032440186,-0.04269409,-0.035949707,-0.10864258,0.08355713,-0.0018396378,-0.07385254,-0.045898438,-0.037231445,-0.02999878,0.032714844,0.016540527,0.044189453,0.012992859,-0.058441162,0.14575195,0.006046295,-0.0012273788,0.00019669533,0.086364746,0.06085205,0.036071777,0.06536865,0.027526855,-0.008804321,-0.04437256,0.047851562,0.012145996,-0.05014038,0.058654785,-0.035095215,0.018920898,0.003435135,0.09173584,-0.07348633,-0.08111572,0.0004451275,0.03668213,0.054504395,0.014251709,0.01512146,-0.03567505,0.052734375,0.023223877,-0.00434494,0.026565552,0.01953125,0.09313965,-0.024612427,0.024093628,0.001619339,0.009056091,0.028335571,-0.10321045,0.004547119,-0.040802002,-0.03173828,0.029129028,0.060333252,0.08306885,0.041107178,0.04711914,0.011756897,0.06060791,-0.02746582,-0.06298828,-0.026535034,-0.010047913,-0.055786133,0.10272217,-0.01399231,-0.04751587,0.052825928,0.0062217712,0.06124878,-0.022262573,-0.015686035,-0.053375244,-0.041503906,-0.13745117,-0.009841919,0.04812622,-0.05935669,-0.00793457,-0.07611084,-0.059783936,0.06604004,0.022369385,-0.00071430206,0.06542969,-0.020263672,-0.05899048,0.021697998,0.017684937,0.038909912,-0.034606934,-0.080200195,0.042022705,-0.031921387,-0.048706055,0.025131226,0.027816772,-0.019851685,0.06616211,-0.0138549805,0.06793213,-0.0059013367,0.0075416565,0.024383545,-0.029388428,-0.022613525,-0.09515381,-0.01927185,0.0060577393,0.03237915,-0.118774414,-0.006088257,-0.0014743805,-0.0065193176,-0.008300781,0.0067329407,0.026229858,0.009208679,0.10662842,-0.055908203,0.075683594,-0.03479004,0.050323486,-0.013763428,-0.0003812313,0.080200195,0.06695557,-0.03881836,0.023361206,-0.023208618,0.01965332,-0.017303467,-0.05847168,0.055664062,-0.12573242,-0.0038795471,-0.027252197,0.008842468,0.066833496,-0.0015382767,-0.07006836,0.042175293,0.041625977,0.0010261536,-0.0035362244,-0.01537323,-0.047210693,0.0647583,0.020187378,-0.026794434,0.0007100105,-0.037109375,-0.02029419,0.00806427,0.082092285,-0.1307373,-0.05328369,-0.007785797,0.026748657,0.024261475,-0.024261475,0.00440979,-0.0018167496,-0.03970337,-0.026260376,0.039031982,0.066833496,-0.045898438,-0.009567261,0.03375244,-0.12347412,-0.031036377,0.002418518,-0.011306763,-0.035614014,-0.018005371,0.015625,0.011123657,0.019851685,0.0118637085,0.047576904,-0.055114746,0.055999756,-0.027664185,-0.008323669,0.08392334,0.049835205,0.045898438,0.100097656,0.048187256,0.05532837,-0.058013916,0.013046265,-0.04788208,-0.15405273,0.011268616,0.06604004,0.059265137,-0.0008883476,-0.08074951,0.0146102905,-0.13574219,-0.009681702,-0.06542969,-0.099365234,0.010368347,0.07104492,0.06762695,0.045440674,-0.034088135,-0.081970215,-0.01687622,-0.07495117,0.03503418,-0.013916016,-0.023101807,-0.0062789917,0.07305908,0.054779053,0.024124146,-0.099853516,-0.018325806,-0.041046143,-7.671118e-05,-0.0362854,0.095336914,-0.027816772,-0.02848816,-0.007911682,0.028961182,0.08288574,0.009063721,0.0033798218,-0.062561035,0.023040771,0.03842163,-0.07122803,0.023208618,0.044525146,0.012451172,-0.02659607,-0.060272217,0.0020713806,0.04724121,0.023880005,0.060516357,0.0020198822,-0.027374268,0.039031982,-0.05001831,-0.05606079,-0.08270264,-0.03982544,0.0345459,-0.03289795,0.050994873,0.010688782,0.04824829,0.089904785,0.0068244934,0.053497314,-0.04611206,-0.0181427,0.033721924,-0.0019683838,0.03189087,0.0057792664,0.0023536682,-0.0847168,-0.07647705,0.051452637,0.024612427,0.029846191,-0.09240723,0.022720337,0.06976318,-0.12866211,-0.093322754,-0.008796692,0.038909912,0.08166504,-0.05734253,-0.0051116943,0.054595947,0.020187378,-0.053710938,-0.0030765533,-0.012710571,0.08111572,0.009155273,0.022521973,0.003314972,-0.02935791,-0.06903076,0.012893677,0.0038166046,0.048858643,-0.07208252,0.07501221,0.008468628,-0.009048462,-0.036499023,-0.05291748,-0.0859375,-0.032928467,0.06323242,0.03665161,-0.053863525,0.04763794,0.008262634,0.016830444,0.04736328,0.09442139,0.03414917,-0.03375244,-0.033233643,-0.08929443,-0.11468506,0.043945312,0.08532715,0.043395996]	0	\N	\N	f	t	Chuck Norris once kicked a horse in the chin and its legs became giraffes.
26	When Chuck Norris does pushups, he doesn't push himself up, he pushes the Earth down.	\N	1	0	1	0	2026-03-31 05:08:26.162477+00	2026-04-01 18:57:09.82+00	[-0.027664185,0.0059318542,0.031311035,0.053588867,0.15332031,0.095336914,0.021942139,0.08068848,-0.070617676,-0.04171753,-0.010116577,0.08325195,-0.060272217,-0.0073165894,0.056121826,0.02444458,-0.00021278858,-0.09436035,-0.08947754,0.025024414,-0.0098724365,0.04837036,0.071777344,0.03491211,0.07550049,0.0016899109,0.10229492,0.05114746,0.04638672,0.085998535,-0.009101868,-0.02168274,-0.04937744,0.004486084,0.07470703,-0.0046691895,0.0029792786,0.009811401,-0.027954102,0.053375244,0.05142212,-0.08660889,-0.018569946,0.032958984,-0.035888672,-0.0037174225,-0.05154419,-0.07165527,0.05090332,0.06109619,-0.08227539,-0.013282776,0.0069618225,0.009300232,0.011268616,0.021240234,-0.036346436,0.018676758,-0.054870605,0.032592773,0.0491333,-0.077941895,0.041992188,0.045959473,-0.061462402,-0.013595581,0.024719238,-0.0016021729,0.029266357,0.057617188,-0.018722534,0.04547119,-0.035461426,0.109375,0.061584473,-0.013542175,-0.016143799,0.034179688,0.017562866,0.03390503,0.041778564,0.0024909973,0.012229919,-0.06854248,0.013465881,-0.011207581,-0.036071777,0.010017395,-0.013320923,0.0178833,0.01638794,-0.057861328,-0.0020122528,-9.9658966e-05,0.014762878,0.023742676,0.08502197,0.09625244,0.06137085,-0.07458496,0.036315918,-0.052734375,0.047790527,-0.019485474,-0.008415222,0.12017822,-0.077697754,-0.00054979324,-0.03579712,0.07489014,0.02218628,-0.07244873,-0.050750732,-0.026947021,-0.070373535,0.030899048,0.020553589,0.06781006,-0.09429932,0.01260376,0.091674805,0.0131073,0.017974854,-0.0052604675,0.018218994,-0.023742676,-0.002500534,0.13647461,-0.045959473,-0.018753052,0.043701172,0.05090332,0.0012140274,0.00819397,0.029159546,0.040985107,-0.10748291,-0.057861328,-0.059387207,0.021560669,-0.035491943,0.013847351,-0.0770874,0.019638062,0.06488037,-0.033813477,0.04324341,0.0031700134,0.0546875,0.03665161,-0.010063171,0.01121521,-0.051971436,0.019226074,-0.0131073,-0.05795288,0.08746338,0.016815186,0.033325195,0.06878662,-0.0004837513,-0.0009050369,-0.08502197,0.03375244,-0.02947998,0.08276367,0.010215759,-0.12200928,-0.03475952,-0.08148193,-0.04751587,-0.007293701,0.07373047,-0.018554688,0.03375244,0.040252686,0.017089844,-0.021240234,0.020462036,0.02368164,0.054870605,0.032684326,0.02532959,0.061706543,-0.0692749,0.08569336,0.008033752,0.14379883,0.022338867,0.087890625,-0.03527832,0.07299805,-0.00046539307,0.017410278,-0.037200928,-0.080200195,0.06640625,-0.072387695,0.015792847,-0.012123108,0.0028705597,0.105163574,0.054382324,-0.016616821,0.010818481,0.025787354,0.013755798,0.07281494,-0.032958984,0.04437256,0.06286621,0.07800293,-0.082092285,-0.0027618408,-0.03189087,-0.035064697,0.044128418,0.010932922,-0.08666992,-0.024505615,-0.02268982,0.041778564,0.056427002,0.012321472,-0.0119018555,0.0138549805,0.11419678,0.0046195984,0.055999756,0.07128906,-0.027252197,0.09124756,0.026626587,-0.041900635,0.019180298,0.06591797,0.0047798157,-0.033843994,-0.042633057,0.046844482,-0.055908203,-0.017196655,-0.020614624,-0.111450195,-0.06274414,0.024139404,-0.033996582,-0.009468079,0.019943237,0.023590088,0.070251465,0.027175903,-0.023834229,-0.025512695,-0.058654785,0.03704834,0.0012378693,-0.044555664,0.031051636,0.08325195,0.033172607,0.06854248,-0.024505615,-0.011795044,-0.088256836,0.09814453,0.007949829,-0.08178711,0.04949951,0.07067871,0.10223389,0.070739746,0.048065186,-0.045043945,-0.0007739067,-0.044830322,0.005748749,-0.0055160522,-0.028213501,-0.009277344,0.00032114983,0.023330688,0.03427124,-0.044921875,-0.0010223389,-0.046875,-0.013969421,0.08557129,-0.0042686462,-0.10308838,0.017562866,-0.033813477,0.030792236,0.080078125,-0.074523926,-0.03579712,-0.004638672,-0.025115967,0.03527832,-0.00018036366,0.020217896,0.051971436,-0.046081543,0.0491333,0.01537323,-0.01977539,0.06274414,-0.059448242,0.08087158,0.00907135,-0.042022705,0.10876465,0.0069084167,0.017913818,-0.011520386,0.002981186,0.0138549805,0.0062675476,-0.045074463,-0.029266357,-0.019470215,0.097229004,0.017227173,-0.023071289,0.037200928,0.032196045,0.1430664,-0.027862549,-0.0006108284,0.06317139,-0.057006836,-0.05621338,-0.03640747,-0.02545166,0.08081055,0.014839172,-0.031555176,0.02507019,0.054656982,-0.08123779,0.0025482178,0.055023193,0.06500244,0.04989624,-0.10626221,-0.047088623,0.008590698,-0.036956787,-0.01802063,0.036895752,0.090148926,0.0725708,-0.02571106,0.017333984,0.053588867,0.0019989014,-0.107299805,0.026733398,0.008918762,-0.014297485,-0.060150146,-0.03164673,0.0069351196,0.030319214,-0.040863037,-0.0019893646,-0.020751953,-0.0010309219,0.021865845,0.026794434,-0.024490356,0.064819336,0.06274414,0.007118225,0.0016078949,0.059448242,0.020324707,0.017868042,0.062561035,-0.085510254,-0.08459473,0.06591797,0.07055664,0.014884949]	0.20654329147389294	\N	\N	f	t	When Chuck Norris does pushups, he doesn't push himself up, he pushes the Earth down.
\.


--
-- Data for Name: hashtags; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.hashtags (id, name, fact_count) FROM stdin;
1	impossible	0
2	legendary	0
3	strong	0
4	math	0
5	smart	0
6	death	0
7	unstoppable	0
8	superman	0
9	badass	0
10	witty	0
11	tough	0
12	animals	0
13	sad	0
14	time	0
15	computers	0
16	fear	0
17	strength	0
\.


--
-- Data for Name: lifetime_entitlements; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.lifetime_entitlements (id, user_id, stripe_payment_intent_id, stripe_customer_id, amount, currency, created_at) FROM stdin;
\.


--
-- Data for Name: membership_history; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.membership_history (id, user_id, event, plan, amount, currency, stripe_payment_intent_id, stripe_subscription_id, stripe_invoice_id, created_at) FROM stdin;
\.


--
-- Data for Name: memes; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.memes (id, fact_id, template_id, image_url, permalink_slug, text_options, created_by_id, created_at) FROM stdin;
1	26	action	/api/memes/46d44c09f702/image	46d44c09f702	{"align": "left", "color": "#ffffff", "fontSize": 28, "verticalPosition": "middle"}	6f2b1072-469b-47c8-9de0-0d5ebdaeb8eb	2026-04-01 02:39:14.498126+00
\.


--
-- Data for Name: password_reset_tokens; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.password_reset_tokens (id, user_id, token_hash, expires_at, used_at, created_at) FROM stdin;
\.


--
-- Data for Name: pending_reviews; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.pending_reviews (id, submitted_text, submitted_by_id, matching_fact_id, matching_similarity, hashtags, status, admin_note, reviewed_by_id, approved_fact_id, created_at, reviewed_at, reason) FROM stdin;
\.


--
-- Data for Name: ratings; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.ratings (fact_id, user_id, rating, created_at) FROM stdin;
24	6f2b1072-469b-47c8-9de0-0d5ebdaeb8eb	up	2026-03-31 05:19:52.389135+00
26	6f2b1072-469b-47c8-9de0-0d5ebdaeb8eb	up	2026-04-01 02:38:28.842768+00
\.


--
-- Data for Name: search_history; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.search_history (id, user_id, query, created_at) FROM stdin;
1	6f2b1072-469b-47c8-9de0-0d5ebdaeb8eb	push	2026-04-01 02:37:39.048722+00
2	6f2b1072-469b-47c8-9de0-0d5ebdaeb8eb	push	2026-04-01 02:37:39.69433+00
3	6f2b1072-469b-47c8-9de0-0d5ebdaeb8eb	push	2026-04-01 02:37:40.313608+00
4	6f2b1072-469b-47c8-9de0-0d5ebdaeb8eb	push	2026-04-01 02:37:40.935211+00
5	6f2b1072-469b-47c8-9de0-0d5ebdaeb8eb	push	2026-04-01 02:37:41.554861+00
6	6f2b1072-469b-47c8-9de0-0d5ebdaeb8eb	push	2026-04-01 02:37:42.189503+00
7	6f2b1072-469b-47c8-9de0-0d5ebdaeb8eb	push	2026-04-01 02:37:42.80801+00
\.


--
-- Data for Name: sessions; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.sessions (sid, sess, expire) FROM stdin;
ed5a8d073a0072cd7760d34402de47d2424a4c4ae3bbe8a190cb9f3cbdf4be69	{"user": {"id": "6f2b1072-469b-47c8-9de0-0d5ebdaeb8eb", "email": "david@davidcarlos.net", "lastName": null, "firstName": "chucknorris", "membershipTier": "free", "profileImageUrl": null}, "isAdmin": true, "access_token": "", "captchaVerified": false}	2026-04-07 18:30:05.725
00bafe3ff1b3949d48e123efaec99b851e489ffc31b132d88277258647b1c464	{"user": {"id": "6f2b1072-469b-47c8-9de0-0d5ebdaeb8eb", "email": "david@davidcarlos.net", "lastName": null, "firstName": "chucknorris", "membershipTier": "free", "profileImageUrl": null}, "isAdmin": true, "access_token": "", "captchaVerified": false}	2026-04-08 02:37:19.915
a4589ad2c691d6a9867d3117e9bf414a3e6dd72d13535aa89a4e8b3e3828fe9c	{"user": {"id": "6f2b1072-469b-47c8-9de0-0d5ebdaeb8eb", "email": "david@davidcarlos.net", "lastName": "Norris", "firstName": "Chuck", "membershipTier": "free", "profileImageUrl": null}, "isAdmin": true, "access_token": "", "captchaVerified": true}	2026-04-08 07:05:26.67
\.


--
-- Data for Name: subscriptions; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.subscriptions (id, user_id, stripe_subscription_id, stripe_customer_id, plan, status, current_period_end, cancel_at_period_end, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: users; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.users (id, email, first_name, last_name, profile_image_url, created_at, updated_at, captcha_verified, is_admin, stripe_customer_id, membership_tier, password_hash, pronouns, is_active, display_name, email_verified_at, pending_email, avatar_style) FROM stdin;
6f2b1072-469b-47c8-9de0-0d5ebdaeb8eb	david@davidcarlos.net	Chuck	Norris	\N	2026-03-31 04:57:39.281142+00	2026-04-01 06:02:20.125+00	t	t	\N	free	$2b$10$L/MThk3BGafYYK9ZwuXvX.16KYOqit0rDYWhLgZoeHZmKl9bgvmqW	he/him	t	\N	\N	\N	bottts
\.


--
-- Name: activity_feed_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.activity_feed_id_seq', 1, false);


--
-- Name: affiliate_clicks_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.affiliate_clicks_id_seq', 1, true);


--
-- Name: comments_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.comments_id_seq', 1, false);


--
-- Name: email_verification_tokens_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.email_verification_tokens_id_seq', 1, false);


--
-- Name: external_links_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.external_links_id_seq', 1, true);


--
-- Name: facts_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.facts_id_seq', 29, true);


--
-- Name: hashtags_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.hashtags_id_seq', 17, true);


--
-- Name: lifetime_entitlements_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.lifetime_entitlements_id_seq', 1, false);


--
-- Name: membership_history_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.membership_history_id_seq', 1, false);


--
-- Name: memes_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.memes_id_seq', 1, true);


--
-- Name: password_reset_tokens_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.password_reset_tokens_id_seq', 1, false);


--
-- Name: pending_reviews_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.pending_reviews_id_seq', 1, false);


--
-- Name: search_history_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.search_history_id_seq', 7, true);


--
-- Name: subscriptions_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.subscriptions_id_seq', 1, false);


--
-- Name: activity_feed activity_feed_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activity_feed
    ADD CONSTRAINT activity_feed_pkey PRIMARY KEY (id);


--
-- Name: affiliate_clicks affiliate_clicks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.affiliate_clicks
    ADD CONSTRAINT affiliate_clicks_pkey PRIMARY KEY (id);


--
-- Name: comments comments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.comments
    ADD CONSTRAINT comments_pkey PRIMARY KEY (id);


--
-- Name: email_verification_tokens email_verification_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_verification_tokens
    ADD CONSTRAINT email_verification_tokens_pkey PRIMARY KEY (id);


--
-- Name: external_links external_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.external_links
    ADD CONSTRAINT external_links_pkey PRIMARY KEY (id);


--
-- Name: fact_hashtags fact_hashtags_fact_id_hashtag_id_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fact_hashtags
    ADD CONSTRAINT fact_hashtags_fact_id_hashtag_id_unique UNIQUE (fact_id, hashtag_id);


--
-- Name: facts facts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.facts
    ADD CONSTRAINT facts_pkey PRIMARY KEY (id);


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
-- Name: lifetime_entitlements lifetime_entitlements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lifetime_entitlements
    ADD CONSTRAINT lifetime_entitlements_pkey PRIMARY KEY (id);


--
-- Name: lifetime_entitlements lifetime_entitlements_stripe_payment_intent_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lifetime_entitlements
    ADD CONSTRAINT lifetime_entitlements_stripe_payment_intent_id_key UNIQUE (stripe_payment_intent_id);


--
-- Name: membership_history membership_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.membership_history
    ADD CONSTRAINT membership_history_pkey PRIMARY KEY (id);


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
-- Name: ratings ratings_fact_id_user_id_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ratings
    ADD CONSTRAINT ratings_fact_id_user_id_unique UNIQUE (fact_id, user_id);


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
-- Name: subscriptions subscriptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_pkey PRIMARY KEY (id);


--
-- Name: subscriptions subscriptions_stripe_subscription_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_stripe_subscription_id_key UNIQUE (stripe_subscription_id);


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
-- Name: users users_stripe_customer_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_stripe_customer_id_key UNIQUE (stripe_customer_id);


--
-- Name: IDX_evt_token_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_evt_token_hash" ON public.email_verification_tokens USING btree (token_hash);


--
-- Name: IDX_prt_token_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_prt_token_hash" ON public.password_reset_tokens USING btree (token_hash);


--
-- Name: IDX_session_expire; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_session_expire" ON public.sessions USING btree (expire);


--
-- Name: facts_parent_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX facts_parent_id_idx ON public.facts USING btree (parent_id);


--
-- Name: facts_wilson_score_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX facts_wilson_score_idx ON public.facts USING btree (wilson_score);


--
-- Name: idx_activity_feed_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_activity_feed_user ON public.activity_feed USING btree (user_id, created_at DESC);


--
-- Name: idx_membership_history_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_membership_history_user_id ON public.membership_history USING btree (user_id);


--
-- Name: idx_pending_reviews_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pending_reviews_status ON public.pending_reviews USING btree (status);


--
-- Name: idx_pending_reviews_submitted_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pending_reviews_submitted_by ON public.pending_reviews USING btree (submitted_by_id);


--
-- Name: activity_feed activity_feed_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activity_feed
    ADD CONSTRAINT activity_feed_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: affiliate_clicks affiliate_clicks_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.affiliate_clicks
    ADD CONSTRAINT affiliate_clicks_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


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
-- Name: email_verification_tokens email_verification_tokens_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_verification_tokens
    ADD CONSTRAINT email_verification_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


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
-- Name: facts facts_parent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.facts
    ADD CONSTRAINT facts_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.facts(id) ON DELETE CASCADE;


--
-- Name: facts facts_submitted_by_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.facts
    ADD CONSTRAINT facts_submitted_by_id_users_id_fk FOREIGN KEY (submitted_by_id) REFERENCES public.users(id);


--
-- Name: lifetime_entitlements lifetime_entitlements_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lifetime_entitlements
    ADD CONSTRAINT lifetime_entitlements_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: membership_history membership_history_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.membership_history
    ADD CONSTRAINT membership_history_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


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
-- Name: password_reset_tokens password_reset_tokens_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.password_reset_tokens
    ADD CONSTRAINT password_reset_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: pending_reviews pending_reviews_approved_fact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pending_reviews
    ADD CONSTRAINT pending_reviews_approved_fact_id_fkey FOREIGN KEY (approved_fact_id) REFERENCES public.facts(id);


--
-- Name: pending_reviews pending_reviews_matching_fact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pending_reviews
    ADD CONSTRAINT pending_reviews_matching_fact_id_fkey FOREIGN KEY (matching_fact_id) REFERENCES public.facts(id);


--
-- Name: pending_reviews pending_reviews_reviewed_by_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pending_reviews
    ADD CONSTRAINT pending_reviews_reviewed_by_id_fkey FOREIGN KEY (reviewed_by_id) REFERENCES public.users(id);


--
-- Name: pending_reviews pending_reviews_submitted_by_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pending_reviews
    ADD CONSTRAINT pending_reviews_submitted_by_id_fkey FOREIGN KEY (submitted_by_id) REFERENCES public.users(id);


--
-- Name: ratings ratings_fact_id_facts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ratings
    ADD CONSTRAINT ratings_fact_id_facts_id_fk FOREIGN KEY (fact_id) REFERENCES public.facts(id) ON DELETE CASCADE;


--
-- Name: ratings ratings_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ratings
    ADD CONSTRAINT ratings_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: search_history search_history_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.search_history
    ADD CONSTRAINT search_history_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: subscriptions subscriptions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- PostgreSQL database dump complete
--

\unrestrict XN4GlrhASLELV4jTDcQfxeivzlWGBAmsQwCtstpubCCUuqUOqH1lKaJbccWIDLC

