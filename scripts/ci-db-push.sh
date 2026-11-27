#!/usr/bin/env bash
# CI 部署的 `supabase db push`：避開 seed 排程窗口，遇到鎖超時自動重試（2026-11-27）。
#
# 為什麼：2026-11-27 13:40 UTC 的 main 部署，migration 第 53 句 DROP TRIGGER 回
#   ERROR: canceling statement due to lock timeout (SQLSTATE 55P03)
# 整支 migration 交易回滾、部署失敗。原因是 pg_cron 的 seed-auto-task-queue-10min 每逢
# :x0 分開跑，單輪約 60～120 秒，對多張表持有 AccessShare 鎖；DROP／CREATE TRIGGER 要
# AccessExclusive，等不到就被 lock_timeout 砍掉。前一晚 23:24 的部署只是沒撞到。
#
# 做法：
#   1. 若現在（UTC，CI 與資料庫都用 UTC）的分鐘數 % 10 在 0、1、2，先等到該十分鐘段的第 3 分鐘。
#   2. db push 失敗且輸出含 55P03 或 lock timeout，最多重試 3 次；每次重試前再避一次窗口，
#      並至少等 20 秒。其他錯誤不重試，直接以原結束碼失敗。
#
# 測試用注入點（正式 CI 不設）：
#   CI_DB_PUSH_NOW_MINUTE / CI_DB_PUSH_NOW_SECOND  假裝現在的分與秒（UTC）
#   CI_DB_PUSH_SLEEP_CMD                           取代 sleep 的指令（收秒數當參數）
#   CI_DB_PUSH_SUPABASE_CMD                        取代 `npx -y supabase@2` 的指令
#   CI_DB_PUSH_MAX_RETRIES / CI_DB_PUSH_MIN_RETRY_WAIT  重試次數（預設 3）與最短等待秒數（預設 20）
set -u

SLEEP_CMD="${CI_DB_PUSH_SLEEP_CMD:-sleep}"
SUPABASE_CMD="${CI_DB_PUSH_SUPABASE_CMD:-npx -y supabase@2}"
MAX_RETRIES="${CI_DB_PUSH_MAX_RETRIES:-3}"
MIN_RETRY_WAIT="${CI_DB_PUSH_MIN_RETRY_WAIT:-20}"

# 現在的分、秒（去掉前導 0，避免被當成八進位）
now_minute() {
  local m="${CI_DB_PUSH_NOW_MINUTE:-$(date -u +%M)}"
  echo $((10#$m))
}
now_second() {
  local s="${CI_DB_PUSH_NOW_SECOND:-$(date -u +%S)}"
  echo $((10#$s))
}

# 在 seed 窗口（:x0～:x2）內就等到第 3 分鐘；$1 是至少要等的秒數（0 代表沒有下限）。
wait_out_of_seed_window() {
  local floor="${1:-0}" m s slot wait=0
  m=$(now_minute)
  s=$(now_second)
  slot=$((m % 10))
  if [ "$slot" -le 2 ]; then
    wait=$(( (3 - slot) * 60 - s ))
    [ "$wait" -lt 1 ] && wait=1
  fi
  if [ "$wait" -gt 0 ]; then
    echo "避開 seed 窗口，等待 ${wait} 秒"
  fi
  if [ "$wait" -lt "$floor" ]; then
    wait="$floor"
    echo "重試前至少等 ${floor} 秒，等待 ${wait} 秒"
  fi
  if [ "$wait" -gt 0 ]; then
    $SLEEP_CMD "$wait"
  fi
}

is_lock_timeout() {
  grep -qiE '55P03|lock timeout' "$1"
}

main() {
  local attempt=0 code
  # out 要是全域變數：EXIT trap 觸發時 main 的區域變數已不存在
  out="$(mktemp "${RUNNER_TEMP:-${TMPDIR:-.}}/ci-db-push.XXXXXX")" || { echo "無法建立暫存檔" >&2; return 1; }
  trap 'rm -f "$out"' EXIT

  wait_out_of_seed_window 0
  while true; do
    # 輸出先存檔再 cat，結束碼取自 supabase 本身，不經管線
    $SUPABASE_CMD db push --linked >"$out" 2>&1
    code=$?
    cat "$out"
    if [ "$code" -eq 0 ]; then
      if [ "$attempt" -gt 0 ]; then echo "db push 成功（重試 ${attempt} 次）"; fi
      return 0
    fi
    if ! is_lock_timeout "$out"; then
      echo "::error::db push 失敗（結束碼 ${code}），不是鎖超時，不重試。"
      return "$code"
    fi
    if [ "$attempt" -ge "$MAX_RETRIES" ]; then
      echo "::error::db push 連續鎖超時，已重試 ${MAX_RETRIES} 次仍失敗。"
      return "$code"
    fi
    attempt=$((attempt + 1))
    echo "db push 遇到鎖超時（55P03），第 ${attempt}/${MAX_RETRIES} 次重試"
    wait_out_of_seed_window "$MIN_RETRY_WAIT"
  done
}

main "$@"
