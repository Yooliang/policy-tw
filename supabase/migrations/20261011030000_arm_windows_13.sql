-- 當屆類 15 支臂補上起訖（工作單 Yooliang/policy-ops#81，維護者 2026-10-11「好 13 支」，再加第 6 段任期中兩支）——提案，維護者點頭才合
-- ============================================================
--
-- 26 支規則還是 P1 種子的「永遠開」；其中 13 支是當屆類，主控台時間軸整條綠。這支把其中 8 支改成照里程碑開關（rule_id 不變、原地 UPDATE），
-- 另外 4 支維持永遠開並寫明理由（再加第 6 段的政見進度過期、到期政見兩支，共 15 支）。正式庫唯讀試算（10-11，用跟 activity_open 一樣的里程碑比對）收回件數寫在每一列的 note 與 PR 說明。
--
--   臂                              起                       迄                  今天收回  投票隔天（11-29）收回
--   raw:policy_missing（當屆缺政見）  —                        投票日              0        1,427（之後由補舊屆政見接手）
--   mayor_policies（縣市長政見）      —                        投票日              0        23
--   raw:roster_check（名單清查）      登記截止                  投票日              0        66
--   roster_villages（村里長名單）     登記截止                  投票日              0        360
--   district_seats（選區名額）        —                        投票日              22（2022）44
--   raw:candidacy_source_missing     —                        投票日              0        3
--   withdrawn_filing（撤回登記）      登記截止                  名單公告日          0        0（今天沒有任務）
--   roster_cec_gap（中選會名單對不上）投票日 +1                 —（不設迄日）       0        0
--   raw:progress_stale（政見進度過期） 就職日                    任期屆滿            5        29（2022 那屆 12-24 屆滿，12-25 起收）
--   deadline_due（到期政見）          就職日                    任期屆滿            0        0（今天沒有任務）
--     ↑ 只改一般那條（rule 5、24，排除村里長）；村里長「有流量才開」那兩條（rule 45、46）照舊永遠開
--   elected_missing（當選人缺紀錄）   投票日 +1                 —（不設迄日）       0        0
--   handover_missing、lineage_candidates／links／roles：維持永遠開（理由見下）
--
-- 跟主線預設不同的地方（PR 說明附理由）：
--   * 名單清查、村里長名單的起點用「登記截止」不用「名單公告日」：它們是照中選會「登記彙總表」核對（登記截止後就有），
--     不是照公告的候選人名單；用名單公告日（11-17）今天會先收回 426 件、11-17 再全部重開。
--   * 中選會名單對不上、當選人缺紀錄不設迄日：兩支都只看 cec_candidates（開票後中選會資料庫的名單），在派的全是 2022／2024 已投票屆別
--     還沒補齊的人（215、112 件）；設「開票後 180 天」今天就收回 327 件、那些人永遠補不到。起點投票日 +1 讓 2026 開票前不派。
--   * 交接缺漏、政見傳承三支維持永遠開：傳承三支的任務 target 沒有選舉（259 件 election_id 全空），照選舉里程碑開窗會整批收回；
--     交接缺漏本體已經只在前一任任期屆滿後才派（from_term_end < 今天）。要照段落畫，得先讓任務帶上選舉，另案。
-- 起訖都照每場選舉、每個職位自己的里程碑；沒有該里程碑的舊屆別窗口關著（迄日型的看投票日，每場都有）。

UPDATE activity_rules SET window_kind = 'event', from_kind = NULL, from_offset = 0, until_kind = 'polling', until_offset = 0,
       note = '當屆類（OPS #81）：到投票日為止，之後由補舊屆政見（term_policies）接手；10-11 試算今天收回 0、11-29 收回 1,427'
 WHERE id = 3 AND activity = 'raw:policy_missing';
UPDATE activity_rules SET window_kind = 'event', from_kind = NULL, from_offset = 0, until_kind = 'polling', until_offset = 0,
       note = '當屆類（OPS #81）：到投票日為止；10-11 試算今天收回 0、11-29 收回 23'
 WHERE id = 31 AND activity = 'mayor_policies';
UPDATE activity_rules SET window_kind = 'event', from_kind = 'registration_close', from_offset = 0, until_kind = 'polling', until_offset = 0,
       note = '當屆類（OPS #81）：登記截止起、到投票日為止（照登記彙總表核對，登記截止後才有得查）；10-11 試算今天收回 0、11-29 收回 66'
 WHERE id = 14 AND activity = 'raw:roster_check';
UPDATE activity_rules SET window_kind = 'event', from_kind = 'registration_close', from_offset = 0, until_kind = 'polling', until_offset = 0,
       note = '當屆類（OPS #81）：同名單清查，登記截止起、到投票日為止；10-11 試算今天收回 0、11-29 收回 360'
 WHERE id = 1 AND activity = 'roster_villages';
UPDATE activity_rules SET window_kind = 'event', from_kind = NULL, from_offset = 0, until_kind = 'polling', until_offset = 0,
       note = '當屆類（OPS #81）：到投票日為止（名額維護者裁示人工核一次）；10-11 試算今天收回 22（2022）、11-29 收回 44'
 WHERE id = 28 AND activity = 'district_seats';
UPDATE activity_rules SET window_kind = 'event', from_kind = NULL, from_offset = 0, until_kind = 'polling', until_offset = 0,
       note = '當屆類（OPS #81）：到投票日為止；10-11 試算今天收回 0（在派的都是 2026）、11-29 收回 3'
 WHERE id = 19 AND activity = 'raw:candidacy_source_missing';
UPDATE activity_rules SET window_kind = 'event', from_kind = 'registration_close', from_offset = 0, until_kind = 'list_published', until_offset = 0,
       note = '當屆類（OPS #81）：登記截止起、到名單公告日為止（沒有「登記開始」里程碑，用登記截止）；10-11 沒有任務'
 WHERE id = 27 AND activity = 'withdrawn_filing';
UPDATE activity_rules SET window_kind = 'event', from_kind = 'polling', from_offset = 1, until_kind = NULL, until_offset = 0,
       note = '當屆類（OPS #81）：投票日 +1 起、不設迄日（只看開票後的中選會名單，在派的是 2022／2024 還沒補齊的人）；10-11 試算收回 0'
 WHERE id = 21 AND activity = 'roster_cec_gap';
UPDATE activity_rules SET window_kind = 'event', from_kind = 'polling', from_offset = 1, until_kind = NULL, until_offset = 0,
       note = '當屆類（OPS #81）：投票日 +1 起、不設迄日（只看開票後的中選會當選名單，在派的是 2022／2024 還沒補齊的人）；10-11 試算收回 0'
 WHERE id = 30 AND activity = 'elected_missing';
UPDATE activity_rules SET window_kind = 'event', from_kind = 'term_start', from_offset = 0, until_kind = 'term_end', until_offset = 0,
       note = '第 6 段任期中（OPS #81）：就職日起到任期屆滿（排除村里長，村里長看 rule 45 有流量才開）；10-11 試算今天收回 5（2024 查不到職位 2、2026 還沒就職 1、沒有屆別 2）、12-25 收回 29'
 WHERE id = 5 AND activity = 'raw:progress_stale';
UPDATE activity_rules SET window_kind = 'event', from_kind = 'term_start', from_offset = 0, until_kind = 'term_end', until_offset = 0,
       note = '第 6 段任期中（OPS #81）：就職日起到任期屆滿（排除村里長，村里長看 rule 46 有流量才開）；10-11 沒有任務'
 WHERE id = 24 AND activity = 'deadline_due';
UPDATE activity_rules SET note = '當屆類但維持永遠開（OPS #81）：本體已經只在前一任任期屆滿後才派；要照段落畫得先讓任務帶上選舉，另案'
 WHERE id = 22 AND activity = 'handover_missing';
UPDATE activity_rules SET note = '當屆類但維持永遠開（OPS #81）：任務 target 沒有選舉，照選舉里程碑開窗會整批收回（10-11 在派 259 件）；要照段落畫得先讓任務帶上選舉，另案'
 WHERE id IN (6, 25, 26) AND activity IN ('lineage_candidates', 'lineage_links', 'lineage_roles');

DO $$
DECLARE v INTEGER;
BEGIN
  SELECT count(*) INTO v FROM activity_rules WHERE id IN (3, 31, 14, 1, 28, 19, 27, 21, 30) AND window_kind = 'event' AND note LIKE '當屆類（OPS #81）%';
  IF v <> 9 THEN RAISE EXCEPTION '當屆類起訖只改到 % 支（應為 9）', v; END IF;
  SELECT count(*) INTO v FROM activity_rules WHERE id IN (5, 24) AND window_kind = 'event' AND from_kind = 'term_start' AND until_kind = 'term_end';
  IF v <> 2 THEN RAISE EXCEPTION '任期中兩支只改到 % 支（應為 2）', v; END IF;
  SELECT count(*) INTO v FROM activity_rules WHERE id IN (22, 6, 25, 26) AND window_kind = 'always' AND note LIKE '當屆類但維持永遠開（OPS #81）%';
  IF v <> 4 THEN RAISE EXCEPTION '維持永遠開的只標到 % 支（應為 4）', v; END IF;
END $$;
