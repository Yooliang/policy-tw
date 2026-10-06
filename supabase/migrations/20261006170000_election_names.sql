-- 選舉名稱統一格式（2026-10-06，維護者點頭）
--
--   name        正式名稱：中選會的名稱、民國年
--   short_name  網站顯示名：西元年＋名稱（頁尾、導覽列、麵包屑、選舉一覽都讀這一欄）
--
--   2022  111年地方公職人員選舉                          2022 九合一選舉
--   2024  113年第16任總統副總統及第11屆立法委員選舉      2024 總統大選
--   2026  115年地方公職人員選舉                          2026 九合一選舉
--
-- 之後補選、罷免投票照同兩條格式命名。elections.id 舊三筆就是年份（見 20261005003441_election_identity.sql）。
-- 引用到的既有欄位：elections(id, name, short_name)。
-- 三列都要改到：少一列就整支退回，不要默默只改一部分。

DO $$
DECLARE
  v_rows INTEGER;
BEGIN
  WITH names(id, name, short_name) AS (VALUES
    (2022, '111年地方公職人員選舉', '2022 九合一選舉'),
    (2024, '113年第16任總統副總統及第11屆立法委員選舉', '2024 總統大選'),
    (2026, '115年地方公職人員選舉', '2026 九合一選舉')
  ), upd AS (
    UPDATE elections e
    SET name = n.name, short_name = n.short_name
    FROM names n
    WHERE e.id = n.id
    RETURNING e.id
  )
  SELECT count(*) INTO v_rows FROM upd;
  IF v_rows <> 3 THEN
    RAISE EXCEPTION '選舉名稱統一：預期改 3 列（2022、2024、2026），實際 %', v_rows;
  END IF;
END $$;
