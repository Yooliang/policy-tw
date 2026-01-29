-- 先刪除重複的關聯
DELETE FROM politician_elections a
USING politician_elections b
WHERE a.ctid < b.ctid
  AND a.politician_id = b.politician_id
  AND a.election_id = b.election_id;

-- 為 politician_elections 新增唯一約束
ALTER TABLE politician_elections
DROP CONSTRAINT IF EXISTS politician_elections_pkey;

ALTER TABLE politician_elections
ADD CONSTRAINT politician_elections_pkey
PRIMARY KEY (politician_id, election_id);
