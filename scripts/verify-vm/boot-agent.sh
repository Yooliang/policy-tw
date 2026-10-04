#!/bin/bash
# 正見驗證代理：開機 → 起一到多個代理 → 跑 run-hours 小時 → 自己關機
# （2026-09-18 建；09-19 加 OpenRouter、多模型平行、一輪做多筆）
# 設定都在 VM metadata，改設定不用 SSH：
#   run-hours           跑幾小時（預設 3）
#   agent-disabled=1    開機只開機、不跑代理（要進去修東西時用）
#   provider            deepseek（預設）或 openrouter  ← 單一代理時用
#   model               單一代理的模型
#   agent-names         代號名單（逗號分隔），單一代理時隨機挑一個
#   agent-name-prefix   名單沒設時的後備：前綴-月日-4碼亂數
#   openrouter-key      provider=openrouter 時必填
#   claude-token        provider=claude 時必填（Claude Code 的 OAuth token，sk-ant-oat…）
#   cwen-token          provider=claude2 時必填＝第二個 Claude 帳號，讓兩個帳號在同一台 VM 併跑
#   agents              多代理平行：`provider:model=代號` 用 | 分隔，例如
#                       openrouter:qwen/qwen3.8-flash=chiawei09|openrouter:deepseek/deepseek-v4-flash=weilun87
#                       有設就忽略上面的 provider/model/agent-names
#                       代號後可接 #persist／#fresh 指定這一隻的 session 模式（不寫就吃 session-mode）
#   session-mode        persist（接著講，前綴命中快取）或 fresh（每筆重開，預設）
U=ext_cwen0708_gmail_com
D=/home/$U/policy-verifier
md() { curl -sf -H "Metadata-Flavor: Google" "http://metadata.google.internal/computeMetadata/v1/instance/attributes/$1"; }

# 上一輪各代理的最後幾行：VM 關機後序列埠就清了，靠這個才看得到上一輪到底卡在哪
for f in "$D"/agent-*.log; do [ -f "$f" ] && { echo "=== PREV-LOG $(basename "$f") ==="; tail -12 "$f"; }; done

if [ "$(md agent-disabled)" = "1" ]; then echo "=== AGENT-SKIP agent-disabled=1 ==="; exit 0; fi

HOURS=$(md run-hours); [[ "$HOURS" =~ ^[0-9]+$ ]] && [ "$HOURS" -ge 1 ] && [ "$HOURS" -le 24 ] || HOURS=3
OR_KEY=$(md openrouter-key)
CLAUDE_TOKEN=$(md claude-token)
# 第二個 Claude 帳號的 token。provider 寫 claude2 就用它（跑的還是同一支 claude CLI）。
CWEN_TOKEN=$(md cwen-token)
# 正見 DiTrust 帳號序號（2026-10-03）：有設就用帳號報到（agent_name=ditrust:<序號>），
# 提交／驗證額度按帳號算（600／2400），不再被 VM 輪到的臨時 IP 當天已用掉的額度卡住。
# 沒設就照舊用每輪的代號（匿名，按 IP 算）。序號只放 metadata，不寫進任何檔案。
DITRUST_SERIAL=$(md ditrust-serial)
[[ "$DITRUST_SERIAL" =~ ^[0-9a-f]{64}$ ]] || DITRUST_SERIAL=""
# 第二個 DiTrust 帳號（2026-10-03）：有設就跟第一組輪替 —— 同一輪的代理單數用第一組、雙數用第二組，
# 兩個帳號各自有 600／2400 的額度。同一筆每個 IP 仍只算一票（兩組都從這台 VM 出去，同一個 IP）。
DITRUST_SERIAL_2=$(md ditrust-serial-2)
# verify-only=1：只做驗證（2026-10-04 小良哥：待驗證堆積，VM 專門跑驗證）
VERIFY_ONLY=$(md verify-only)
[[ "$DITRUST_SERIAL_2" =~ ^[0-9a-f]{64}$ ]] || DITRUST_SERIAL_2=""
CPROMPT_IDX=0

# Claude Code 是選配：只有 agents 裡出現 claude: 才裝，省開機時間。
# 裝進 root 的全域 npm，執行時由 sudo -u 借用 /usr/local/bin/claude。
ensure_claude() {
  command -v claude >/dev/null 2>&1 && return 0
  echo "=== INSTALL claude-code 開始 ==="
  if ! command -v node >/dev/null 2>&1; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1
    apt-get install -y nodejs >/dev/null 2>&1
  fi
  npm install -g @anthropic-ai/claude-code >/dev/null 2>&1
  if command -v claude >/dev/null 2>&1; then
    echo "=== INSTALL claude-code 完成 $(claude --version 2>&1 | head -1) ==="
  else
    echo "=== INSTALL claude-code 失敗 ==="
  fi
}

# 改回逐筆（2026-09-19 晚，小良哥裁示）。
# 中間試過「一輪做滿 10 筆再結束」想攤掉重讀 skill.md 的成本，結果 qwen3.8-flash 那顆
# 整整一小時 0 筆——很可能是它把成果累積到最後才要回報，先被單次 20 分鐘上限砍掉，
# 跑了、花了錢、什麼都沒交。做一筆就結束雖然每筆都要重讀協議，但每一筆都真的落地。
PROMPT_TAIL='照協議領一筆任務：GET /next → 查證 → POST /report，一輪做完就結束。'

# session 模式（2026-09-19 深夜）：
#   persist 接著講——固定 session id，skill.md 只讀一次，之後每輪只追加「領下一筆」。
#           前綴一樣，供應商端的 context cache 才命中得到；小良哥本機連著跑就是便宜在這。
#   fresh   每筆重開（原本的做法），每次都是全新對話、每次都是 cache miss 全價。
# 上下文不能無限長，所以 persist 每 ROUNDS_PER_SESSION 輪換一個 session id。
SESSION_MODE=$(md session-mode); case "$SESSION_MODE" in persist|fresh) ;; *) SESSION_MODE=fresh ;; esac
ROUNDS_PER_SESSION=8

# Claude Code 的提示詞寫成檔案再餵進去。
# 直接寫在 claude -p "..." 裡會踩到兩個坑：外層已經有好幾層引號，而範例 curl 裡的
# <id> 會被 shell 當成輸入重導向，prompt 就被截成空字串（2026-09-23 實測整輪空轉）。
write_cprompt() {
  local N="$1" M="$2" F="$D/cprompt-$1.txt"
  cat > "$F" <<'CPROMPT_EOF'
你正在協助維護「正見」（policy-tw），台灣的政見追蹤開放資料平台，這台機器屬於該專案的維護者。工作是查證公開資料並投票，端點公開、不需金鑰。

步驟：
1. 用 WebFetch 讀 https://xn--2lw665d.tw/skill.md，那是這個平台的公開貢獻規則（欄位格式、共識門檻、來源等級）。
2. 用 Bash 執行：curl -sS "https://wiiqoaytpqvegtknlbue.supabase.co/functions/v1/next?agent_name=__LOGIN__&agent_tool=claude-code/__MODEL__"
   取得一件待辦。
3. 依回應的 kind 處理：
   - kind=verify：對 source_urls 的每個網址用 WebFetch 抓原始內容，逐字核對它是否支持這筆宣稱。符合投 agree 並引用原文那一句；不符投 disagree 並附反證網址；判不出來投 unsure。不要用搜尋引擎摘要代替原文。
   - kind=task：依 what_we_need 去找官方來源（中選會、縣市選委會、政府公告、媒體原文）。找不到就回 no_change 並說明查了什麼，不要硬湊。
   🔴 **region（縣市）一定要跟你實際打開的那份名冊／來源一致，不是照抄任務給的值。** 任務給的 region 是「請你清查這個縣市」，不是「這些人都屬於這個縣市」。名冊 PDF 常把鄰近縣市排在同一份或相鄰頁次，很容易把別的縣市的人照任務的 region 填下去。交每一筆 candidacy 前問自己一次：**我是在哪一份名冊的哪一頁看到這個人的？那份名冊的縣市是什麼？** 跟任務給的 region 不一致就填你看到的那個，一整批人看起來不像同一個縣市就停下來重看，不要整批照任務的值送。
     （roster_check 本身的 election_id／region／election_type 三個欄位仍要原樣帶回任務 target 的值，那是在回報「我清查了哪一個名單」，跟個別 candidacy 的 region 是兩件事。）
   - kind=none：結束這一輪。
   ⚠️ 若這筆的型別是 merge_politician（合併兩位同名人物）：這是高風險操作，合錯了很難救。請逐欄比對兩筆是不是同一人——出生年、選區、參選紀錄都要對得上；identity_candidates 的 why 只是線索不是結論，要自己打開來源驗。第二來源不要用中選會的候選人 API（提交者多半用它，會被判同網域），改找縣市議會的議員介紹頁或地方媒體對該屆議員的報導，而且只能附你實際打開過的網址。證據不足就投 unsure，判定不是同一人就 disagree 並附反證。**不要因為它排在佇列最前面就放寬標準。**
4. 回報。POST 一定要用 Bash 工具跑 curl，WebFetch 只能 GET、送不出 POST，用它會失敗並讓你誤以為 API 掛掉。把 JSON 先寫成檔案再送最穩：
   把 body 寫進 /tmp/report.json（欄位依 skill.md 與這次的 kind 決定，agent_name 填 __LOGIN__、agent_tool 填 claude-code/__MODEL__），然後執行：
   curl -sS -X POST https://wiiqoaytpqvegtknlbue.supabase.co/functions/v1/report -H "Content-Type: application/json" --data @/tmp/report.json
   送出後看回應的 status 與 score 確認伺服器收到了。
   🔴 **收到 HTTP 400 `unreachable_but_fetchable` 不是退件，不要放棄這一筆。** 意思是你回報「來源打不開」，但伺服器當場自己抓到了可用正文（可能是 web.archive.org 的存檔），回應裡附著它實際抓到的網址。請**打開那個網址、照內容改判 confirmed 或 not_found，然後重送這一筆**，不要維持原本的「打不開」。
   順帶一提：回 unreachable 前至少要試過帶瀏覽器 User-Agent 重試、換一家媒體或站內搜尋找同一篇、web.archive.org 存檔（存檔常回 429，退避 20 秒以上再試，一次 429 不算拿不到）。三條都拿不到才算真的打不開；只要拿得到內容就照內容判 confirmed／not_found。
5. 每處理完一筆，先用一行把它記下來（格式：時間 contribution_id 型別 verdict 分數變化），再回到步驟 2 領下一筆，不要結束。重複到下列任一情況才停：
   - kind=none 連續三次
   - 回應的 quota 裡 submit 或 verify 剩餘低於 15%
   - 你已經處理滿 40 筆
   🔴 紀律：**每一筆都要當場 POST 出去、確認伺服器收到，才去領下一筆**。絕對不要把好幾筆的結果留到最後一起送——這個環境有單次時間上限，留到最後會整批丟失。
   步驟 1 的 skill.md 只在這一輪的第一筆讀一次就好，後面幾筆沿用同一份規則，不必重讀（除非回應裡的 protocol_version 跟你讀到的版本不一樣）。
CPROMPT_EOF
  if [ "$VERIFY_ONLY" = "1" ]; then
    cat >> "$F" <<'VONLY_EOF'
6. 🔴 這一輪**只做驗證**：/next 回 kind=verify 照常核對投票；回 kind=task 就**不要做**，改打 /next 並在網址加 &skip=<那筆的 task_id> 跳過，伺服器會給下一件。連續三次 skip 都還是 task 才結束這一輪。停止條件改為：kind=none 連續三次／驗證額度剩餘低於 15%／已處理滿 60 筆。
VONLY_EOF
  fi
  CPROMPT_IDX=$((CPROMPT_IDX + 1))
  local SER="$DITRUST_SERIAL"
  [ -n "$DITRUST_SERIAL_2" ] && [ $((CPROMPT_IDX % 2)) -eq 0 ] && SER="$DITRUST_SERIAL_2"
  local LOGIN="$N"; [ -n "$SER" ] && LOGIN="ditrust:$SER"
  sed -i "s|__LOGIN__|$LOGIN|g; s|__NAME__|$N|g; s|__MODEL__|$M|g" "$F"
  chown "$U:" "$F" 2>/dev/null
}

# 一個代理 = 一個背景迴圈。$1 provider $2 model $3 代號
start_agent() {
  local P="$1" M="$2" N="$3" SM="${4:-$SESSION_MODE}"
  case "$P" in claude|claude2) write_cprompt "$N" "$M" ;; esac
  echo "=== AGENT-START name=$N provider=$P model=$M hours=$HOURS session=$SM ==="
  echo "$N $(date -u +%FT%TZ) hours=$HOURS provider=$P model=$M" >> "$D/agent-runs.log"
  ( PROVIDER="$P" MODEL="$M" NAME="$N" ORK="$OR_KEY" CTOK="$( [ "$P" = claude2 ] && echo "$CWEN_TOKEN" || echo "$CLAUDE_TOKEN" )" TAIL="$PROMPT_TAIL" SMODE="$SM" RPS="$ROUNDS_PER_SESSION" \
    timeout "${HOURS}h" sudo -u "$U" -H --preserve-env=PROVIDER,MODEL,NAME,ORK,CTOK,TAIL,SMODE,RPS bash -c '
      set -a; . "$HOME/policy-verifier/.env"; set +a
      cd "$HOME/policy-verifier"
      # 刻意不讀 .env 的 POLICY_MODEL：那裡設的是 pro，2026-09-18 因此整輪跑成 pro。
      [ "$PROVIDER" = openrouter ] && export OPENROUTER_API_KEY="$ORK"
      case "$PROVIDER" in claude|claude2) export CLAUDE_CODE_OAUTH_TOKEN="$CTOK" ;; esac
      ROUND=0; SID=""
      while true; do
        ROUND=$((ROUND+1))
        if [ "$SMODE" = persist ]; then
          # 每 RPS 輪換一個 session，避免上下文無限長
          if [ -z "$SID" ] || [ $(( (ROUND-1) % RPS )) -eq 0 ]; then
            SID="$NAME-$(date -u +%H%M%S)"; FIRST=1
          else
            FIRST=0
          fi
          if [ "$FIRST" = 1 ]; then
            MSG="請讀 https://policy-tw.web.app/skill.md。你的代號（agent_name）是 $NAME，agent_tool 填 pi/$MODEL。$TAIL"
          else
            MSG="繼續：$TAIL 協議你已經讀過，不必重讀（除非 /next 回的 protocol_version 跟你手上的不一樣）。"
          fi
          timeout 20m pi --provider "$PROVIDER" --model "$MODEL" --session-id "$SID" -p "$MSG" 2>&1 | tee -a "$HOME/policy-verifier/agent-$NAME.log" | tail -40
        elif [ "$PROVIDER" = claude ] || [ "$PROVIDER" = claude2 ]; then
          # Claude Code：headless -p，跳過權限詢問（VM 上沒有人能按）。
          # 協議網址用新網域（2026-09-22 啟用），端點仍在 Supabase，skill.md 裡寫得很清楚。
          timeout 60m claude -p "$(cat "$HOME/policy-verifier/cprompt-$NAME.txt")" --model "$MODEL" --dangerously-skip-permissions 2>&1 | tee -a "$HOME/policy-verifier/agent-$NAME.log" | tail -40
        else
          # 單次上限 20 分鐘：便宜模型（尤其 :free 那些）可能排隊排到天荒地老，
          # 卡住一次就吃掉整個時段。卡住就重來，下一輪換個任務。
          timeout 20m pi --provider "$PROVIDER" --model "$MODEL" -p "請讀 https://policy-tw.web.app/skill.md。你的代號（agent_name）是 $NAME，agent_tool 填 pi/$MODEL。$TAIL" 2>&1 | tee -a "$HOME/policy-verifier/agent-$NAME.log" | tail -40
        fi
        sleep 10
      done
    ' ) &
}

# 模型字串的字元白名單。OpenRouter 的 slug 有斜線、冒號，別名還帶波浪號
# （~deepseek/deepseek-flash-latest）；2026-09-19 漏了 ~ 讓一整輪跑成無效 model ID、一小時 0 筆。
valid_model() { [[ "$1" =~ ^[A-Za-z0-9._/:~-]{2,64}$ ]]; }
valid_name()  { [[ "$1" =~ ^[A-Za-z0-9._-]{2,64}$ ]]; }

STARTED=0
AGENTS=$(md agents)
if [ -n "$AGENTS" ]; then
  # 多代理：provider:model=代號，用 | 分隔
  IFS='|' read -ra SPECS <<< "$AGENTS"
  for spec in "${SPECS[@]}"; do
    P="${spec%%:*}"; rest="${spec#*:}"; M="${rest%%=*}"; N="${rest##*=}"
    SM="$SESSION_MODE"
    case "$N" in *"#"*) SM="${N##*#}"; N="${N%%#*}" ;; esac
    case "$SM" in persist|fresh) ;; *) SM=fresh ;; esac
    case "$P" in deepseek|openrouter|claude|claude2) ;; *) echo "=== AGENT-SKIP-SPEC provider 不合法：$spec ==="; continue ;; esac
    if [ "$P" = claude ] || [ "$P" = claude2 ]; then
      [ "$P" = claude  ] && [ -z "$CLAUDE_TOKEN" ] && { echo "=== AGENT-SKIP-SPEC 缺 claude-token：$spec ==="; continue; }
      [ "$P" = claude2 ] && [ -z "$CWEN_TOKEN" ]   && { echo "=== AGENT-SKIP-SPEC 缺 cwen-token：$spec ==="; continue; }
      ensure_claude
      command -v claude >/dev/null 2>&1 || { echo "=== AGENT-SKIP-SPEC claude 裝不起來：$spec ==="; continue; }
    fi
    if ! valid_model "$M" || ! valid_name "$N"; then echo "=== AGENT-SKIP-SPEC 格式不合法：$spec ==="; continue; fi
    if [ "$P" = openrouter ] && [ -z "$OR_KEY" ]; then echo "=== AGENT-SKIP-SPEC 缺 openrouter-key：$spec ==="; continue; fi
    start_agent "$P" "$M" "$N" "$SM"; STARTED=$((STARTED+1))
  done
fi

if [ "$STARTED" -eq 0 ]; then
  # 單一代理（舊行為）
  PROVIDER=$(md provider); case "$PROVIDER" in deepseek|openrouter) ;; *) PROVIDER=deepseek ;; esac
  AGENT_MODEL=$(md model)
  if [ "$PROVIDER" = openrouter ] && { ! valid_model "$AGENT_MODEL" || [ -z "$OR_KEY" ]; }; then
    echo "=== AGENT-FALLBACK provider=openrouter 但 model 或 key 不合法，退回 deepseek flash ==="
    PROVIDER=deepseek; AGENT_MODEL=deepseek-v4-flash
  fi
  [ "$PROVIDER" = deepseek ] && case "$AGENT_MODEL" in deepseek-v4-flash|deepseek-v4-pro) ;; *) AGENT_MODEL=deepseek-v4-flash ;; esac
  NAMES=()
  for n in $(md agent-names | tr "," " "); do valid_name "$n" && NAMES+=("$n"); done
  if [ "${#NAMES[@]}" -gt 0 ]; then
    NAME="${NAMES[RANDOM % ${#NAMES[@]}]}"
  else
    PREFIX=$(md agent-name-prefix); [[ "$PREFIX" =~ ^[A-Za-z0-9._-]{2,40}$ ]] || PREFIX=verifier
    NAME="$PREFIX-$(date -u +%m%d)-$(tr -dc a-z0-9 </dev/urandom | head -c4)"
  fi
  start_agent "$PROVIDER" "$AGENT_MODEL" "$NAME"; STARTED=1
fi
chown "$U:" "$D/agent-runs.log" 2>/dev/null

# 舊的常駐服務不要再跑：它把代號寫死在提示詞裡，而且沒有時間上限
systemctl disable --now policy-agent 2>/dev/null

# 不論是跑滿時數、出錯或被中斷，最後一律關機，不留一台空轉的機器在計費
trap 'echo "=== AGENT-END started=$STARTED ==="; shutdown -h now' EXIT
wait
