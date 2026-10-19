/**
 * 「換號沿用排隊位置」（migration 20261019040000／20261019040100，#670 第 8、9 點）對 seed_auto_task_queue 做的機械式替換——
 * 給 rekey-keeps-queue-position.test.ts（正見：新定義＝前一版加這幾處替換）與 policy-jp-dispatch-drift.test.ts（日本站：還原後＝正見舊版加這幾處替換）共用，
 * 兩邊吃同一份文字，改一處兩邊一起動，不可能各寫各的。
 *
 * 每一處是 [原文, 新文]：原文在「正見的 seed 定義」裡必須剛好出現一次（20261011350000 與 20261017010000 兩版在這幾處一字不差，
 * 驗證票那兩處〔補驗證列、最後的 refresh_verify_ticket_keys〕不在這幾處之內）。日本站的 seed 用 toJp() 把同一份替換加上 policy_jp. 前綴。
 *
 * 不是測試檔（沒有 .test.ts），deno test 不會單獨跑它。
 */
export type RekeyEdit = [string, string];

/** 收回之前先記下「穩定鍵」相同、這一輪就要被取代的舊列的排隊位置（插在「窗口關了」那段之前） */
const CAPTURE_ANCHOR = "  -- >>> gap_events window：臂自己還算得出來這個缺口、只是規則的窗口關了";
const CAPTURE_BLOCK = `  -- >>> 換號沿用排隊位置（20261019040000）：帶清單指紋的臂（task_rekey_arms）的 task_id 末段是那一格內容的指紋，格子裡任何一條政見一動指紋就變：
  --     舊列被收回、新列用新 task_id 出生，進隊時間重算＝排回隊尾（正式庫 10-19：佇列延遲約 14 天、這幾臂的列壽命中位數 12～21 小時，幾乎永遠輪不到）。
  --     收回之前先記下「穩定鍵」（task_id 去掉末段指紋）相同、這一輪就要被取代的舊列的排隊位置，下面新增時沿用；沒有舊列的新缺口照舊
  DROP TABLE IF EXISTS _rekey_prev;
  CREATE TEMP TABLE _rekey_prev ON COMMIT DROP AS
  WITH fresh AS MATERIALIZED (
    SELECT DISTINCT task_rekey_stable_key(g.task_id) AS skey
      FROM _gaps g
     WHERE task_rekey_stable_key(g.task_id) IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM task_dispatches y WHERE y.task_id = g.task_id)
  )
  SELECT DISTINCT ON (d.skey) d.skey, d.task_id AS prev_task_id, d.last_dispatched_at, d.dispatch_count, d.boost_seconds,
         COALESCE((d.opened_by->>'chain_opened_at')::TIMESTAMPTZ, d.opened_at) AS chain_opened_at
    FROM (SELECT x.*, task_rekey_stable_key(x.task_id) AS skey FROM task_dispatches x WHERE x.task_id LIKE 'auto:%') d
    JOIN fresh f ON f.skey = d.skey
   WHERE NOT EXISTS (SELECT 1 FROM _gaps g WHERE g.task_id = d.task_id)
     AND COALESCE((SELECT q.rekey_keep_position FROM queue_settings q WHERE q.id = 1), true)
   ORDER BY d.skey, d.queue_at, d.task_id;
  -- <<< 換號沿用排隊位置

`;

export const REKEY_EDITS: RekeyEdit[] = [
  [CAPTURE_ANCHOR, CAPTURE_BLOCK + CAPTURE_ANCHOR],
  // 新增列：進隊時間（last_dispatched_at，排序鍵由觸發器 task_dispatches_queue_key 照它算）與派出次數沿用舊列的；沒有舊列就是 now()、0
  [
    "  SELECT g.task_id, now(), v_base + (row_number() OVER (ORDER BY g.task_id) - 1) * INTERVAL '2 seconds', 0,\n",
    "  SELECT g.task_id, COALESCE(r.last_dispatched_at, now()), v_base + (row_number() OVER (ORDER BY g.task_id) - 1) * INTERVAL '2 seconds', COALESCE(r.dispatch_count, 0),  -- 換號沿用排隊位置（queue_at 這個值觸發器會照進隊時間重算）\n",
  ],
  // 出生紀錄：記是接誰的位置（rekey_of）與整串換號的第一次出生時間（chain_opened_at，慢性停擺檢查用）
  [
    "         g.opened_by || jsonb_strip_nulls(jsonb_build_object('priority_rule_id', g.priority_rule_id, 'priority_seconds', g.priority_seconds)),\n",
    "         g.opened_by || jsonb_strip_nulls(jsonb_build_object('priority_rule_id', g.priority_rule_id, 'priority_seconds', g.priority_seconds))\n" +
      "           || CASE WHEN r.skey IS NULL THEN '{}'::JSONB ELSE jsonb_build_object('rekey_of', r.prev_task_id, 'chain_opened_at', r.chain_opened_at) END,  -- 換號沿用排隊位置\n",
  ],
  // 插隊秒數：舊列還沒被派出過的插隊（/boost）跟著走；派出過的舊列觸發器早就歸零了，所以「派出過的不繼承插隊」是自然的
  [
    "CASE WHEN g.arm LIKE 'manual\\_%' THEN COALESCE(manual_front_seconds(g.task_id), 0) ELSE 0 END\n",
    "CASE WHEN g.arm LIKE 'manual\\_%' THEN COALESCE(manual_front_seconds(g.task_id), 0) ELSE COALESCE(r.boost_seconds, 0) END  -- 換號沿用排隊位置\n",
  ],
  [
    "    FROM _gaps g\n   WHERE NOT EXISTS (SELECT 1 FROM task_dispatches d WHERE d.task_id = g.task_id)\n  ON CONFLICT (task_id) DO NOTHING;\n",
    "    FROM _gaps g\n    LEFT JOIN _rekey_prev r ON r.skey = task_rekey_stable_key(g.task_id)  -- 換號沿用排隊位置\n   WHERE NOT EXISTS (SELECT 1 FROM task_dispatches d WHERE d.task_id = g.task_id)\n  ON CONFLICT (task_id) DO NOTHING;\n",
  ],
];

/** 日本站的 seed 是正見的複本（表與函式帶 policy_jp. 前綴）：同一份替換，識別字前面加前綴 */
export function toJp(s: string): string {
  return s.replace(/\b(task_dispatches|queue_settings|task_rekey_stable_key|manual_front_seconds)\b(?!_)/g, "policy_jp.$1");
}
export const REKEY_EDITS_JP: RekeyEdit[] = REKEY_EDITS.map(([a, b]) => [toJp(a), toJp(b)]);

/** 精確改一處（原文必須剛好出現一次） */
export function applyRekeyEdits(src: string, edits: RekeyEdit[]): string {
  let s = src;
  for (const [from, to] of edits) {
    const n = s.split(from).length - 1;
    if (n !== 1) throw new Error(`要改的字串必須剛好出現一次（出現 ${n} 次）：${from.slice(0, 70)}`);
    s = s.replace(from, () => to);
  }
  return s;
}

/** activity_health 多的那一個 UNION 分支（接在前一版最後一個分支 queue_head_stale 後面；20261019040000） */
export const HEALTH_BRANCH = `  UNION ALL
  SELECT 'dispatch_chronic_stall', s.arm,
         '派工類型「' || s.arm || '」近 ' || s.window_days || ' 天有 ' || s.closed_rows || ' 列因缺口內容變了被換掉，列的壽命（整串換號合計）中位數只有 ' || s.median_life_hours
           || ' 小時，短於目前的佇列延遲 ' || s.queue_delay_hours || ' 小時，而且這段期間沒有任何交件：還沒輪到就被換掉，幾乎永遠派不出去。看 gap_events 的 closed 事件與派工列 opened_by 的 rekey_of'
    FROM dispatch_chronic_stall() s`;
export const HEALTH_COMMENT_ADDENDUM =
  "  '｜2026-10-19：加 dispatch_chronic_stall——某一類自動缺口近 N 天被換掉的列夠多、壽命中位數短於佇列延遲、又沒有任何交件（#670 第 9 點；參數在 queue_settings 的 stall_*）。'";
