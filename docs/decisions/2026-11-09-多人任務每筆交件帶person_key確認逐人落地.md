# 多人任務每筆交件帶 person_key，確認掛對人逐人落地（2026-11-09，小良核准，協議 1.122.0）

起因：名冊分組任務（d9042ce1…、a2035078…）的「核對掛錯人」各被派了 9 次不收斂。
1. 代理對某位交 `no_change`＋`confirmed`，多人任務分支只回「已記錄」，沒寫 `task_checks`；掛錯人臂只在 `task_checks.task_id='auto:candidacy_owner_mismatch:<pe_id>'` 且 `outcome='confirmed'` 時排除那一位，所以對帳永遠不會移除他。
2. 同一張任務不同人的 `no_change` 被同一宣稱鍵（只看 task_id）當成同一件，只有第一筆算數，其餘 superseded。

裁決：
- 多人任務每筆交件必須帶 `payload.person_key`（照抄 `target.people[].key`），沒帶或不在名單回 400（`person_key_required`／`person_key_unknown`）；`no_change` 另要帶該位 `politician_election_id`（`person_key_mismatch`）。不從自由文字推測。
- 同一宣稱鍵與驗證提示都以 `person_key` 區分。
- `no_change confirmed`（掛錯人）落庫時寫 `auto:candidacy_owner_mismatch:<pe_id>` 的 `task_checks`；其他做法的臂沒有逐人的 confirmed 排除，維持只記錄。
- 不改偵測規則（county_jump／submitted_region）。
