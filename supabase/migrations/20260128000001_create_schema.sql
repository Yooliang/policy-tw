-- ============================================================
-- ENUM Types
-- ============================================================

CREATE TYPE policy_status AS ENUM (
  'Proposed',
  'In Progress',
  'Achieved',
  'Stalled',
  'Failed',
  'Campaign Pledge'
);

CREATE TYPE political_party AS ENUM (
  '國民黨',
  '民進黨',
  '民眾黨',
  '無黨籍'
);

CREATE TYPE election_type AS ENUM (
  '縣市長',
  '縣市議員',
  '鄉鎮市長',
  '直轄市山地原住民區長',
  '鄉鎮市民代表',
  '直轄市山地原住民區民代表',
  '村里長'
);

CREATE TYPE politician_status AS ENUM (
  'incumbent',
  'politician',
  'potential',
  'former'
);

-- ============================================================
-- Reference Tables
-- ============================================================

CREATE TABLE categories (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE locations (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

-- ============================================================
-- Core Tables
-- ============================================================

CREATE TABLE elections (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  short_name TEXT NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  election_date DATE NOT NULL
);

CREATE TABLE election_types (
  id SERIAL PRIMARY KEY,
  election_id TEXT NOT NULL REFERENCES elections(id) ON DELETE CASCADE,
  type election_type NOT NULL,
  UNIQUE(election_id, type)
);

CREATE TABLE politicians (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  party political_party NOT NULL,
  status politician_status DEFAULT 'politician',
  election_type election_type,
  position TEXT NOT NULL,
  region TEXT NOT NULL,
  sub_region TEXT,
  avatar_url TEXT NOT NULL,
  slogan TEXT,
  bio TEXT,
  education TEXT[],
  experience TEXT[]
);

CREATE TABLE politician_elections (
  id SERIAL PRIMARY KEY,
  politician_id TEXT NOT NULL REFERENCES politicians(id) ON DELETE CASCADE,
  election_id TEXT NOT NULL REFERENCES elections(id) ON DELETE CASCADE,
  UNIQUE(politician_id, election_id)
);

CREATE TABLE policies (
  id TEXT PRIMARY KEY,
  politician_id TEXT NOT NULL REFERENCES politicians(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  category TEXT NOT NULL,
  status policy_status NOT NULL DEFAULT 'Proposed',
  proposed_date DATE NOT NULL,
  last_updated DATE NOT NULL,
  progress INTEGER NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 100),
  tags TEXT[],
  ai_analysis TEXT,
  support_count INTEGER DEFAULT 0
);

CREATE TABLE tracking_logs (
  id TEXT PRIMARY KEY,
  policy_id TEXT NOT NULL REFERENCES policies(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  event TEXT NOT NULL,
  description TEXT
);

CREATE TABLE related_policies (
  id SERIAL PRIMARY KEY,
  policy_id TEXT NOT NULL REFERENCES policies(id) ON DELETE CASCADE,
  related_policy_id TEXT NOT NULL REFERENCES policies(id) ON DELETE CASCADE,
  UNIQUE(policy_id, related_policy_id),
  CHECK(policy_id <> related_policy_id)
);

CREATE TABLE discussions (
  id TEXT PRIMARY KEY,
  policy_id TEXT NOT NULL REFERENCES policies(id) ON DELETE CASCADE,
  policy_title TEXT NOT NULL,
  author_id TEXT NOT NULL,
  author_name TEXT NOT NULL,
  author_avatar_url TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  likes INTEGER DEFAULT 0,
  tags TEXT[],
  created_at TEXT NOT NULL,
  created_at_ts BIGINT NOT NULL,
  view_count INTEGER DEFAULT 0
);

CREATE TABLE discussion_comments (
  id TEXT PRIMARY KEY,
  discussion_id TEXT NOT NULL REFERENCES discussions(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL,
  author_name TEXT NOT NULL,
  author_avatar_url TEXT NOT NULL,
  content TEXT NOT NULL,
  likes INTEGER DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE comment_replies (
  id TEXT PRIMARY KEY,
  comment_id TEXT NOT NULL REFERENCES discussion_comments(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL,
  author_name TEXT NOT NULL,
  author_avatar_url TEXT NOT NULL,
  content TEXT NOT NULL,
  likes INTEGER DEFAULT 0,
  created_at TEXT NOT NULL
);

-- ============================================================
-- Indexes
-- ============================================================

CREATE INDEX idx_policies_politician_id ON policies(politician_id);
CREATE INDEX idx_policies_status ON policies(status);
CREATE INDEX idx_policies_category ON policies(category);
CREATE INDEX idx_tracking_logs_policy_id ON tracking_logs(policy_id);
CREATE INDEX idx_politician_elections_politician_id ON politician_elections(politician_id);
CREATE INDEX idx_politician_elections_election_id ON politician_elections(election_id);
CREATE INDEX idx_discussions_policy_id ON discussions(policy_id);
CREATE INDEX idx_discussion_comments_discussion_id ON discussion_comments(discussion_id);
CREATE INDEX idx_comment_replies_comment_id ON comment_replies(comment_id);
CREATE INDEX idx_politicians_status ON politicians(status);
CREATE INDEX idx_politicians_region ON politicians(region);
CREATE INDEX idx_election_types_election_id ON election_types(election_id);

-- ============================================================
-- RLS (Row Level Security)
-- ============================================================

ALTER TABLE elections ENABLE ROW LEVEL SECURITY;
ALTER TABLE election_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE politicians ENABLE ROW LEVEL SECURITY;
ALTER TABLE politician_elections ENABLE ROW LEVEL SECURITY;
ALTER TABLE policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE tracking_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE related_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE discussions ENABLE ROW LEVEL SECURITY;
ALTER TABLE discussion_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE comment_replies ENABLE ROW LEVEL SECURITY;

-- Public read access for all tables
CREATE POLICY "Public read access" ON elections FOR SELECT USING (true);
CREATE POLICY "Public read access" ON election_types FOR SELECT USING (true);
CREATE POLICY "Public read access" ON politicians FOR SELECT USING (true);
CREATE POLICY "Public read access" ON politician_elections FOR SELECT USING (true);
CREATE POLICY "Public read access" ON policies FOR SELECT USING (true);
CREATE POLICY "Public read access" ON tracking_logs FOR SELECT USING (true);
CREATE POLICY "Public read access" ON related_policies FOR SELECT USING (true);
CREATE POLICY "Public read access" ON categories FOR SELECT USING (true);
CREATE POLICY "Public read access" ON locations FOR SELECT USING (true);
CREATE POLICY "Public read access" ON discussions FOR SELECT USING (true);
CREATE POLICY "Public read access" ON discussion_comments FOR SELECT USING (true);
CREATE POLICY "Public read access" ON comment_replies FOR SELECT USING (true);

-- ============================================================
-- Views
-- ============================================================

CREATE OR REPLACE VIEW policies_with_logs AS
SELECT
  p.*,
  COALESCE(
    (SELECT json_agg(
      json_build_object(
        'id', tl.id,
        'date', tl.date,
        'event', tl.event,
        'description', tl.description
      ) ORDER BY tl.date
    )
    FROM tracking_logs tl
    WHERE tl.policy_id = p.id),
    '[]'::json
  ) AS logs,
  COALESCE(
    (SELECT json_agg(rp.related_policy_id)
     FROM related_policies rp
     WHERE rp.policy_id = p.id),
    '[]'::json
  ) AS related_policy_ids
FROM policies p;

CREATE OR REPLACE VIEW politicians_with_elections AS
SELECT
  pol.*,
  COALESCE(
    (SELECT json_agg(pe.election_id)
     FROM politician_elections pe
     WHERE pe.politician_id = pol.id),
    '[]'::json
  ) AS election_ids
FROM politicians pol;

CREATE OR REPLACE VIEW discussions_full AS
SELECT
  d.*,
  COALESCE(
    (SELECT json_agg(
      json_build_object(
        'id', dc.id,
        'author', json_build_object(
          'id', dc.author_id,
          'name', dc.author_name,
          'avatarUrl', dc.author_avatar_url
        ),
        'content', dc.content,
        'likes', dc.likes,
        'createdAt', dc.created_at,
        'replies', COALESCE(
          (SELECT json_agg(
            json_build_object(
              'id', cr.id,
              'author', json_build_object(
                'id', cr.author_id,
                'name', cr.author_name,
                'avatarUrl', cr.author_avatar_url
              ),
              'content', cr.content,
              'likes', cr.likes,
              'createdAt', cr.created_at
            ) ORDER BY cr.created_at
          )
          FROM comment_replies cr
          WHERE cr.comment_id = dc.id),
          '[]'::json
        )
      ) ORDER BY dc.created_at
    )
    FROM discussion_comments dc
    WHERE dc.discussion_id = d.id),
    '[]'::json
  ) AS comments
FROM discussions d;
