SET default_transaction_read_only = on;
SET statement_timeout = '30s';
-- 主控台時間軸每次開頁都會跑這兩支（policy-tw #565 審查要求的量測）。用法：npx supabase db query --linked -f scripts/console-timeline-explain.sql
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM console_timeline_elections();
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM console_timeline('2026');
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM policy_jp.console_timeline((SELECT election_id FROM policy_jp.console_timeline_elections() LIMIT 1));
