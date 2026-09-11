-- 政見的「提出日期」不一定查得到。欄位原本是 NOT NULL，
-- 落庫程式只好在缺值時填當天，結果 2024 年立委選舉公報的政見
-- 被標成「提出：2026-09-11」——那是資料送進來的日子，不是政見提出的日子。
-- 改成可為空：查不到就留空，由前端改顯示所屬選舉屆別。
ALTER TABLE policies ALTER COLUMN proposed_date DROP NOT NULL;

-- 清掉邏輯上不可能的日期：政見不可能在該屆選舉結束之後才提出。
UPDATE policies p
SET proposed_date = NULL
FROM elections e
WHERE p.election_id = e.id
  AND p.proposed_date IS NOT NULL
  AND p.proposed_date > e.end_date;

-- 也清掉未來日期（沒有屆別可比對的情況）。
UPDATE policies
SET proposed_date = NULL
WHERE proposed_date > CURRENT_DATE;
