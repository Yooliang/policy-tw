-- 公報網址：修正雲林縣鄉鎮市民代表 18 個選舉單位已失效（404）的公報路徑，並補上 12 個原本沒有公報的單位
--
-- 為什麼：2026-11-17 建索引時抓到的雲林縣公報檔，之後在中選會公報站被換檔名（二崙、古坑、大埤、崙背、莿桐），
--   舊網址現在全部回 404，這 18 個單位的候選人補政見任務因此一直讀不到公報。
--   另外口湖、水林、褒忠 3 個鄉當時索引沒有對到檔案（檔名只寫「代表N」或「一-四區」），也一併補上。
--   新路徑都取自 2026-11-24 的公報站全站清單，且逐一 HEAD 實測 200；口湖、水林、莿桐的「代表N」逐份開啟確認就是第 N 選舉區。
-- 怎麼改：①把要改的 18 列備份到 election_bulletins_backup_20261124 ②UPDATE 只限這 18 列（主鍵明列）
--   ③INSERT 12 個新單位（ON CONFLICT DO NOTHING，不動既有列）④每步先斷言筆數，不符就中止。
--   politician_bulletins 是視圖，直接讀這張表，不用另外動；歷史查核紀錄（task_checks）不動。
-- 回滾：UPDATE election_bulletins b SET paths = k.paths, match_basis = k.match_basis, listed_on = k.listed_on
--          FROM election_bulletins_backup_20261124 k WHERE b.id = k.id;
--        DELETE FROM election_bulletins WHERE election_id = 2026 AND listed_on = DATE '2026-11-24'
--          AND id NOT IN (SELECT id FROM election_bulletins_backup_20261124);

CREATE TABLE IF NOT EXISTS election_bulletins_backup_20261124 AS
  SELECT * FROM election_bulletins WHERE id IN (14190, 14191, 14192, 14193, 14194, 14203, 14204, 14217, 14218, 14219, 14220, 14221, 14222, 14223, 14224, 14241, 14242, 14243);
ALTER TABLE election_bulletins_backup_20261124 ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM election_bulletins_backup_20261124;
  IF n <> 18 THEN
    RAISE EXCEPTION '備份筆數 % 不是預期的 18，中止', n;
  END IF;
  SELECT count(*) INTO n FROM election_bulletins
   WHERE id IN (14190, 14191, 14192, 14193, 14194, 14203, 14204, 14217, 14218, 14219, 14220, 14221, 14222, 14223, 14224, 14241, 14242, 14243) AND election_id = 2026 AND election_type = '鄉鎮市民代表' AND region = '雲林縣';
  IF n <> 18 THEN
    RAISE EXCEPTION '要更正的列只有 % 筆，預期 18，中止', n;
  END IF;
END $$;

UPDATE election_bulletins b
   SET paths = v.paths, match_basis = v.basis, listed_on = DATE '2026-11-24'
  FROM (VALUES
    (14190, ARRAY['115/11雲林縣/04鄉鎮市民代表/二崙鄉/1118二崙-代表%20公報.pdf'], '鄉鎮一份'),
    (14191, ARRAY['115/11雲林縣/04鄉鎮市民代表/二崙鄉/1118二崙-代表%20公報.pdf'], '鄉鎮一份'),
    (14192, ARRAY['115/11雲林縣/04鄉鎮市民代表/二崙鄉/1118二崙-代表%20公報.pdf'], '鄉鎮一份'),
    (14193, ARRAY['115/11雲林縣/04鄉鎮市民代表/二崙鄉/1118二崙-代表%20公報.pdf'], '鄉鎮一份'),
    (14194, ARRAY['115/11雲林縣/04鄉鎮市民代表/二崙鄉/1118二崙-代表%20公報.pdf'], '鄉鎮一份'),
    (14203, ARRAY['115/11雲林縣/04鄉鎮市民代表/古坑鄉/古坑鄉民代表選舉公報（三選區）-1.pdf'], '選區'),
    (14204, ARRAY['115/11雲林縣/04鄉鎮市民代表/古坑鄉/古坑鄉民代表選舉公報（四選區）-2.pdf'], '選區'),
    (14217, ARRAY['115/11雲林縣/04鄉鎮市民代表/大埤鄉/大埤鄉民代表第一選區公報.pdf'], '選區'),
    (14218, ARRAY['115/11雲林縣/04鄉鎮市民代表/大埤鄉/大埤鄉民代表第二選區公報.pdf'], '選區'),
    (14219, ARRAY['115/11雲林縣/04鄉鎮市民代表/大埤鄉/大埤鄉民代表第三選區公報.pdf'], '選區'),
    (14220, ARRAY['115/11雲林縣/04鄉鎮市民代表/大埤鄉/大埤鄉民代表第四選區公報.pdf'], '選區'),
    (14221, ARRAY['115/11雲林縣/04鄉鎮市民代表/崙背鄉/崙背鄉-第1選區.pdf'], '選區'),
    (14222, ARRAY['115/11雲林縣/04鄉鎮市民代表/崙背鄉/崙背鄉-第2選區.pdf'], '選區'),
    (14223, ARRAY['115/11雲林縣/04鄉鎮市民代表/崙背鄉/崙背鄉-第3選區.pdf'], '選區'),
    (14224, ARRAY['115/11雲林縣/04鄉鎮市民代表/崙背鄉/崙背鄉-第4選區.pdf'], '選區'),
    (14241, ARRAY['115/11雲林縣/04鄉鎮市民代表/莿桐鄉/代表1.pdf'], '選區'),
    (14242, ARRAY['115/11雲林縣/04鄉鎮市民代表/莿桐鄉/代表2.pdf'], '選區'),
    (14243, ARRAY['115/11雲林縣/04鄉鎮市民代表/莿桐鄉/代表3.pdf'], '選區')
  ) AS v(id, paths, basis)
 WHERE b.id = v.id;

INSERT INTO election_bulletins (election_id, election_type, region, sub_region, village, paths, match_basis, listed_on) VALUES
(2026,'鄉鎮市民代表','雲林縣','口湖鄉第01選舉區','',ARRAY['115/11雲林縣/04鄉鎮市民代表/口湖鄉/口湖鄉民代表1.pdf'],'選區',DATE '2026-11-24'),
(2026,'鄉鎮市民代表','雲林縣','口湖鄉第02選舉區','',ARRAY['115/11雲林縣/04鄉鎮市民代表/口湖鄉/口湖鄉民代表2.pdf'],'選區',DATE '2026-11-24'),
(2026,'鄉鎮市民代表','雲林縣','口湖鄉第03選舉區','',ARRAY['115/11雲林縣/04鄉鎮市民代表/口湖鄉/口湖鄉民代表3.pdf'],'選區',DATE '2026-11-24'),
(2026,'鄉鎮市民代表','雲林縣','口湖鄉第04選舉區','',ARRAY['115/11雲林縣/04鄉鎮市民代表/口湖鄉/口湖鄉民代表4.pdf'],'選區',DATE '2026-11-24'),
(2026,'鄉鎮市民代表','雲林縣','水林鄉第01選舉區','',ARRAY['115/11雲林縣/04鄉鎮市民代表/水林鄉/水林鄉民代表1.pdf'],'選區',DATE '2026-11-24'),
(2026,'鄉鎮市民代表','雲林縣','水林鄉第02選舉區','',ARRAY['115/11雲林縣/04鄉鎮市民代表/水林鄉/水林鄉民代表2.pdf'],'選區',DATE '2026-11-24'),
(2026,'鄉鎮市民代表','雲林縣','水林鄉第03選舉區','',ARRAY['115/11雲林縣/04鄉鎮市民代表/水林鄉/水林鄉民代表3.pdf'],'選區',DATE '2026-11-24'),
(2026,'鄉鎮市民代表','雲林縣','水林鄉第04選舉區','',ARRAY['115/11雲林縣/04鄉鎮市民代表/水林鄉/水林鄉民代表4.pdf'],'選區',DATE '2026-11-24'),
(2026,'鄉鎮市民代表','雲林縣','褒忠鄉第01選舉區','',ARRAY['115/11雲林縣/04鄉鎮市民代表/褒忠鄉/褒忠選舉公報--鄉民代表一-四區.pdf'],'鄉鎮一份',DATE '2026-11-24'),
(2026,'鄉鎮市民代表','雲林縣','褒忠鄉第02選舉區','',ARRAY['115/11雲林縣/04鄉鎮市民代表/褒忠鄉/褒忠選舉公報--鄉民代表一-四區.pdf'],'鄉鎮一份',DATE '2026-11-24'),
(2026,'鄉鎮市民代表','雲林縣','褒忠鄉第03選舉區','',ARRAY['115/11雲林縣/04鄉鎮市民代表/褒忠鄉/褒忠選舉公報--鄉民代表一-四區.pdf'],'鄉鎮一份',DATE '2026-11-24'),
(2026,'鄉鎮市民代表','雲林縣','褒忠鄉第04選舉區','',ARRAY['115/11雲林縣/04鄉鎮市民代表/褒忠鄉/褒忠選舉公報--鄉民代表一-四區.pdf'],'鄉鎮一份',DATE '2026-11-24')
ON CONFLICT (election_id, election_type, region, sub_region, village) DO NOTHING;

DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM election_bulletins WHERE election_id = 2026 AND listed_on = DATE '2026-11-24' AND election_type = '鄉鎮市民代表';
  IF n <> 30 THEN
    RAISE EXCEPTION '今天更正與新增的列是 % 筆，預期 30，中止', n;
  END IF;
END $$;
