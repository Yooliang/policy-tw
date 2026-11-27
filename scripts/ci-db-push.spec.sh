#!/usr/bin/env bash
# scripts/ci-db-push.sh 的測試：用假的 supabase 與假的 sleep，不碰網路也不真的等。
# 執行：bash scripts/ci-db-push.spec.sh
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/ci-db-push.sh"
WORK="$(mktemp -d "$HERE/.ci-db-push-spec.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

# 假 supabase：依 FAKE_SEQ（逗號分隔：ok／lock／other）逐次回應，並記錄呼叫次數
cat >"$WORK/fake-supabase" <<'EOF'
#!/usr/bin/env bash
n=$(cat "$FAKE_COUNT" 2>/dev/null || echo 0)
n=$((n + 1))
echo "$n" >"$FAKE_COUNT"
IFS=',' read -r -a seq <<<"$FAKE_SEQ"
step="${seq[$((n - 1))]:-${seq[$((${#seq[@]} - 1))]}}"
case "$step" in
  ok)    echo "Applying migration ... done"; exit 0 ;;
  lock)  echo "ERROR: canceling statement due to lock timeout (SQLSTATE 55P03)"; exit 1 ;;
  other) echo "ERROR: syntax error at or near \"FOO\" (SQLSTATE 42601)"; exit 1 ;;
esac
EOF
# 假 sleep：把秒數記進檔案
cat >"$WORK/fake-sleep" <<'EOF'
#!/usr/bin/env bash
echo "$1" >>"$FAKE_SLEEPS"
EOF
chmod +x "$WORK/fake-supabase" "$WORK/fake-sleep"

fail=0
check() { # 名稱 條件結果(0=過)
  if [ "$2" -eq 0 ]; then echo "PASS $1"; else echo "FAIL $1"; fail=1; fi
}

# 跑一次：run_case <序列> <分> <秒>；結果放在 CODE、OUT、CALLS、SLEEPS
run_case() {
  rm -f "$WORK/count" "$WORK/sleeps"
  : >"$WORK/sleeps"
  OUT="$(FAKE_SEQ="$1" FAKE_COUNT="$WORK/count" FAKE_SLEEPS="$WORK/sleeps" \
    CI_DB_PUSH_NOW_MINUTE="$2" CI_DB_PUSH_NOW_SECOND="$3" \
    CI_DB_PUSH_SLEEP_CMD="$WORK/fake-sleep" CI_DB_PUSH_SUPABASE_CMD="$WORK/fake-supabase" \
    bash "$SCRIPT" 2>&1)"
  CODE=$?
  CALLS="$(cat "$WORK/count" 2>/dev/null || echo 0)"
  SLEEPS="$(tr '\n' ' ' <"$WORK/sleeps" | sed 's/ *$//')"
}

# ① 第一次 55P03、第二次成功：整體成功、重試 1 次、重試前至少等 20 秒
run_case "lock,ok" 35 0
check "1 整體成功" "$([ "$CODE" -eq 0 ]; echo $?)"
check "1 呼叫 2 次（重試 1 次）" "$([ "$CALLS" -eq 2 ]; echo $?)"
check "1 重試前等 20 秒" "$([ "$SLEEPS" = "20" ]; echo $?)"

# ② 非鎖錯誤：不重試、直接失敗
run_case "other,ok" 35 0
check "2 失敗" "$([ "$CODE" -ne 0 ]; echo $?)"
check "2 只呼叫 1 次" "$([ "$CALLS" -eq 1 ]; echo $?)"

# ③ 分鐘數在窗口內：先等到第 3 分鐘（:41 分 30 秒 → 等 90 秒）
run_case "ok" 41 30
check "3 成功" "$([ "$CODE" -eq 0 ]; echo $?)"
check "3 等 90 秒" "$([ "$SLEEPS" = "90" ]; echo $?)"
check "3 印出避窗訊息" "$(printf '%s' "$OUT" | grep -q '避開 seed 窗口，等待 90 秒'; echo $?)"

# ③b 窗口邊界：:x0 分 0 秒等 180 秒；:x3 不等
run_case "ok" 50 0
check "3b :50:00 等 180 秒" "$([ "$SLEEPS" = "180" ]; echo $?)"
run_case "ok" 53 0
check "3b :53 不等" "$([ -z "$SLEEPS" ]; echo $?)"

# ④ 一直鎖超時：重試 3 次後失敗（共呼叫 4 次）
run_case "lock" 35 0
check "4 失敗" "$([ "$CODE" -ne 0 ]; echo $?)"
check "4 呼叫 4 次" "$([ "$CALLS" -eq 4 ]; echo $?)"

# ⑤ 重試時剛好落在窗口內：等窗口的時間（較長者）
run_case "lock,ok" 49 50
# 第一次在 :49 不等；失敗後時鐘仍是假的 :49，不在窗口，只等下限 20 秒
check "5 成功" "$([ "$CODE" -eq 0 ]; echo $?)"

exit "$fail"
