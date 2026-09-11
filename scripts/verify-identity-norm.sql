-- 由 scripts/gen-identity-norm-check.mjs 自動產生，勿手改；改案例請改 normalization-cases.json 後重跑。
-- 用途：驗 migration 20260911000001 的 SQL 正規化函式與 TS 版（identity-normalize.ts）行為一致。
-- 期望：回傳 0 列。有列就是兩邊分歧，列出 fn / 輸入 / 期望 / 實得。
WITH cases(fn, input, expected) AS (VALUES
  ('identity_norm_text', ' 臺北市　議員 ', '台北市議員'::TEXT),
  ('identity_norm_text', 'ＡＢＣ１２３', 'ABC123'::TEXT),
  ('identity_norm_text', '劉清明 Isamu', '劉清明Isamu'::TEXT),
  ('identity_norm_text', '', NULL::TEXT),
  ('identity_norm_text', '無', NULL::TEXT),
  ('identity_norm_text', '未知', NULL::TEXT),
  ('identity_norm_party', '國民黨', '中國國民黨'::TEXT),
  ('identity_norm_party', '中國國民黨', '中國國民黨'::TEXT),
  ('identity_norm_party', '民進黨', '民主進步黨'::TEXT),
  ('identity_norm_party', '民眾黨', '台灣民眾黨'::TEXT),
  ('identity_norm_party', '無黨籍及未經政黨推薦', '無黨籍'::TEXT),
  ('identity_norm_party', '無', NULL::TEXT),
  ('identity_norm_party', '時代力量', '時代力量'::TEXT),
  ('identity_norm_party', '台灣基進', '台灣基進'::TEXT),
  ('identity_norm_position', '基隆市議長', '縣市議員'::TEXT),
  ('identity_norm_position', '基隆市議會議長', '縣市議員'::TEXT),
  ('identity_norm_position', '111年直轄市議員選舉', '縣市議員'::TEXT),
  ('identity_norm_position', '縣市議員候選人', '縣市議員'::TEXT),
  ('identity_norm_position', '立委候選人', '立法委員'::TEXT),
  ('identity_norm_position', '立法委員（第10屆起連任至今）', '立法委員'::TEXT),
  ('identity_norm_position', '立法院副院長', '立法委員'::TEXT),
  ('identity_norm_position', '前立法委員', '立法委員'::TEXT),
  ('identity_norm_position', '台北市副市長', '副縣市長'::TEXT),
  ('identity_norm_position', '彰化縣長候選人', '縣市長'::TEXT),
  ('identity_norm_position', '111年直轄市長選舉', '縣市長'::TEXT),
  ('identity_norm_position', '111年嘉義市長重行選舉', '縣市長'::TEXT),
  ('identity_norm_position', '南投縣縣長', '縣市長'::TEXT),
  ('identity_norm_position', '縣市長', '縣市長'::TEXT),
  ('identity_norm_position', '鄉鎮市長候選人', '鄉鎮市長'::TEXT),
  ('identity_norm_position', '111年直轄市區民代表選舉', '鄉鎮市民代表'::TEXT),
  ('identity_norm_position', '直轄市山地原住民區民代表', '直轄市山地原住民區民代表'::TEXT),
  ('identity_norm_position', '直轄市山地原住民區長', '直轄市山地原住民區長'::TEXT),
  ('identity_norm_position', '村里長候選人', '村里長'::TEXT),
  ('identity_norm_position', '副總統候選人', '總統副總統'::TEXT),
  ('identity_norm_position', '中華民國總統', '總統副總統'::TEXT),
  ('identity_norm_position', '民眾黨主席', '民眾黨主席'::TEXT),
  ('identity_norm_position', '前台北市黨部主委', '前台北市黨部主委'::TEXT),
  ('identity_norm_position', '無', NULL::TEXT),
  ('identity_norm_position', '未知', NULL::TEXT),
  ('identity_norm_position', '', NULL::TEXT),
  ('identity_norm_election_type', '縣市長', '縣市長'::TEXT),
  ('identity_norm_election_type', '直轄市山地原住民區民代表', '直轄市山地原住民區民代表'::TEXT),
  ('identity_norm_election_type', '立委', '立法委員'::TEXT),
  ('identity_norm_election_type', '縣長', '縣市長'::TEXT),
  ('identity_norm_election_type', '其他', NULL::TEXT),
  ('identity_norm_election_type', NULL, NULL::TEXT),
  ('identity_position_strength', '縣市長', 2::TEXT),
  ('identity_position_strength', '立法委員', 2::TEXT),
  ('identity_position_strength', '副縣市長', 2::TEXT),
  ('identity_position_strength', '民眾黨主席', 2::TEXT),
  ('identity_position_strength', '縣市議員', 1::TEXT),
  ('identity_position_strength', '鄉鎮市長', 1::TEXT),
  ('identity_position_strength', '村里長', 1::TEXT)
),
actual AS (
  SELECT fn, input, expected,
    CASE fn
      WHEN 'identity_norm_text' THEN identity_norm_text(input)
      WHEN 'identity_norm_party' THEN identity_norm_party(input)
      WHEN 'identity_norm_position' THEN identity_norm_position(input)
      WHEN 'identity_norm_election_type' THEN identity_norm_election_type(input)
      WHEN 'identity_position_strength' THEN identity_position_strength(input)::TEXT
    END AS got
  FROM cases
)
SELECT fn, input, expected, got
FROM actual
WHERE got IS DISTINCT FROM expected
ORDER BY fn, input;
