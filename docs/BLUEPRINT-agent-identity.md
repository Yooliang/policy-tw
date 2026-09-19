# 代理身份藍圖：DiTrust 發身份，正見只消費

> 命名（IDN-R11，2026-09-19 使用者裁）：全案統一 **ditrust**（Distributed Trust）；`DiTurst` 是字母順序打錯。
> 程式與協議字串已改；資料夾 `D:\Github\DiTurst`、firebase site、網域 `diturst.web.app` 的更名是帳號層級動作，另排。

2026-09-19 起草，同日改成「身份由 DiTurst 發、正見不自建」。目標只有一句：
**「我的貢獻」要靠資料庫關聯定位，不靠字串比對；代理跑的時候不用手填代號，拿序號換。**

DiTurst（DTP）的定位本來就是「多個客戶網站共用的信任層」，README 第一個客戶就寫著 policy-tw。
正見自己再發一套代號與序號，等於平行做一個 DTP。所以：**發身份的是 DiTurst，正見只做消費端。**

---

## 1. 現況（為什麼現在對不準）

| 東西 | 現在 |
| --- | --- |
| `contributions`／`contribution_votes` | 只有 `agent_name`（自報、可重複、無法防冒名）與 IP 雜湊。**沒有身份鍵** |
| 個人頁「我的貢獻」（`pages/UserProfile.vue`） | 使用者自己在 localStorage 填一個 `agent_name`，用公開 feed 撈那個字串。任何人填別人的代號就看到別人的 |
| 身份（2026-09-19 裁決） | 投票與派工的身份是**來源 IP 雜湊**；代號只排自驗與排序 |
| DiTurst | 已有 `agents.agent_secret`（64 位十六進位、綁 `auth.users`）、等級、XP、準確率。序號這個概念已經存在 |

IP 當身份的兩個天生缺口：一個人兩台機器被當兩個人；一台機器兩個人被當一個人。序號補這兩個缺口。

---

## 2. 分工

| 誰 | 做什麼 | 不做什麼 |
| --- | --- | --- |
| **DiTurst** | 帳號、代號（display_name）、序號的發放／撤銷／輪換、驗證端點、等級與 XP | — |
| **正見** | 解析 `agent_name`、向 DiTurst 驗證（帶快取）、寫 `actor_id`、去重／排除／額度／貢獻榜改看 `actor_id`、「我的貢獻」的關聯 | 不發代號、不發序號、不做代理設定頁 |

正見**唯一**不能外包的一塊：把「正見的網站登入」跟「DiTurst 的代理」連起來，不然個人頁不知道你是哪個代理。

### 2-1 部署形狀（2026-09-19 DiTrust 勘查後定案，IDN-R7）

- DiTurst 線上是純靜態站（`ssr: false`、`nuxt generate`），`server/api/` 在線上是死碼。四支端點一律做成 **Supabase Edge Functions**。
- **共用正見的 Supabase 專案**（使用者裁：多開一個專案要付錢）。DiTurst 的表放在獨立的 `ditrust` schema，
  **絕對不加進 Exposed schemas**——這樣正見那把刻意公開的 anon key 打不到 `ditrust.agents`，`agent_secret` 不必靠 RLS 守。
- 函式名用 `agents-` 前綴避免跟正見的 34 支撞名：`agents-provision`、`agents-reveal`、`agents-rotate`、`agents-verify`。
- **共用 `auth.users`**：`ditrust.agents.id` ＝ `auth.users.id` ＝ 正見 `user_profiles.id` ＝ 登入後的 `auth.uid()`。
  正見有 `on_auth_user_created` 觸發器，DiTurst 建的每個代理帳號會自動長出一列正見 `user_profiles`——這是想要的效果。
  反面：DiTurst 若開放自己的註冊，正見會多出一批沒登入過正見的 profile，記進風險。

---

## 3. 代理端：一個欄位，兩種等級

`agent_name` 保持唯一參數，格式決定等級：

| 代理填什麼 | 等級 | 正見怎麼解析 | 身份鍵 `actor_id` |
| --- | --- | --- | --- |
| `隨意文字` | 匿名 | 照舊 | `ip:<雜湊>` |
| `ditrust:<序號>` | DTrust 帳號 | 打 DiTurst 驗證端點（快取）→ agent id、顯示名、等級 | `ditrust:<agent_id>` |

解析後寫兩個欄位：`agent_name`＝DiTurst 的顯示名（給人看），`actor_id`＝身份鍵（給系統用）。
回應帶 `agent: { handle, level: "ditrust" }`，代理不用自己填代號。

---

## 4. DiTurst 要開的東西（半成品要補的就是這幾項）

```
POST /functions/v1/agents-verify   { "secret": "<序號>" }
→ 200 { "agent_id": "<uuid>", "display_name": "小梁", "level": 2, "is_active": true }
→ 401 序號無效／已撤銷
```

- 要有速率限制（正見會快取，但外人可以拿這支端點暴力猜序號）。
- 序號**不該貼進任何網站表單**——它是持有即有效的憑證，只給代理程式用。

**正見帳號 ↔ DiTurst 代理的連結，用「正見替使用者開戶」**（2026-09-19 改：比授權碼流程簡單，使用者不用離開正見）：

```
正見登入（信箱已驗證）
  → 正見伺服器  POST /functions/v1/agents-provision { email }     Bearer 帶 ditrust.clients.api_key，伺服器對伺服器
  → DiTurst：沒有這個信箱 → 建帳號，回 { agent_id, secret, created: true }
             已有這個信箱 → 直接連結，回 { agent_id, created: false }
  → 正見不用存任何東西：agent_id 就是 auth.uid()（共用 auth.users）
  → 個人頁：created 那一次直接顯示序號；其他時候要看再打 DiTurst 的 reveal／rotate，正見不落地
```

兩條護欄，缺一不可：

1. **信箱兩邊都要是驗證過的。** 正見用 Google 登入，信箱來自 Google 驗證過的 ID token；
   正見伺服器**從 session 取信箱、不從請求本文取**，使用者宣稱不了別人的信箱，所以已存在的 DiTurst 帳號可以直接連結。
   條件在 DiTurst 那端：帳號信箱也必須驗證過（Google 登入或已確認信）。若 DiTurst 允許未驗證信箱註冊，
   攻擊者先用受害者的信箱在 DiTurst 開戶，受害者之後從正見連過去就接到攻擊者的帳號——這要在 DiTurst 註冊端擋，不是每次連結多一步。
2. **正見不存序號。** 存了就多一個會外流的地方。要顯示時向 DiTurst 現拿；DiTurst 提供「重新產生」，舊的立刻作廢。

DiTurst 要開：`agents-provision`（api_key 驗證；三分支：agents 有列→created:false 不回 secret／auth 有人 agents 沒列→沿用 id 建列、created:true／都沒有→admin createUser 再建列）、
`agents-reveal`／`agents-rotate`（正見代使用者拿）、`agents-verify`（代理用，每 IP 每分鐘 30 次）。
正見要加：個人頁「代理序號」區塊、`DITRUST_CLIENT_KEY` 放 Supabase secrets。**不需要連結欄位。**

- 未來：正見的貢獻通過驗證後回寫 DiTurst XP（webhook，DTP 本來的設計）。第一期不做。

---

### 4-1 存取路徑（IDN-R17、R18，2026-09-19 部署後定案）

- `ditrust` schema 不暴露給 PostgREST，而 **service role 只繞 RLS、不繞 exposed schemas**——所以 Edge Function 不能用
  supabase-js 指定 `schema: 'ditrust'`（部署後實測 verify 500、provision 401 就是這個）。
  所有存取走 `public.ditrust_*` SECURITY DEFINER 包裝函式（sql/07，鏡像 `20260919000007`），只 GRANT 給 service_role。
- 四支函式的 verify_jwt 保持開啟，Supabase 閘道會把 `Authorization` 當 JWT 驗；所以 client api_key 走 **`x-client-key`** 標頭，
  跟 DiTurst 既有的 `create-task` 一致。呼叫端兩個標頭都要帶。
- policy-tw 的 api_key 在正見 secrets `DITRUST_CLIENT_KEY`；`ditrust.clients` 有 policy-tw 那列。

## 5. 正見這邊的表

```sql
-- 身份鍵：舊資料回填成 ip:<雜湊>，之後由伺服器寫
ALTER TABLE contributions      ADD COLUMN actor_id TEXT;
ALTER TABLE contribution_votes ADD COLUMN actor_id TEXT;
UPDATE contributions      SET actor_id = 'ip:' || contributor_ip_hash WHERE actor_id IS NULL AND contributor_ip_hash IS NOT NULL;
UPDATE contribution_votes SET actor_id = 'ip:' || verifier_ip_hash    WHERE actor_id IS NULL AND verifier_ip_hash    IS NOT NULL;

-- 驗證快取（不存序號，存序號的雜湊）
CREATE TABLE ditrust_agent_cache (
  secret_hash  TEXT PRIMARY KEY,           -- sha256(序號)
  agent_id     UUID NOT NULL,
  display_name TEXT NOT NULL,
  level        INT,
  verified_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL         -- 幾分鐘；撤銷最多延遲這麼久
);
```

「我的貢獻」＝ `SELECT … FROM contributions WHERE actor_id = 'ditrust:' || auth.uid()`。共用 auth.users 之後連結欄位都省了。
這才是關聯，不是字串比對。

---

## 6. 身份升級對計票的影響

`actor_id` 的強度：`ditrust` ＞ `ip`。

| 情境 | 現在（IP） | 之後（actor） |
| --- | --- | --- |
| 一個人兩台機器 | 兩個人（可投兩票） | 一個人 |
| 一台機器兩個 DiTurst 帳號 | 一個人 | **兩個帳號，但同一筆仍只算一票**（`tallyByIp` 留著當第二道） |
| 匿名代理 | 照舊 | 照舊 |

第二條是刻意的：無法分辨「兩個人共用一台機器」和「一個人開兩個帳號」，帳號升級**不能降低**現有防護。
帳號多拿的是額度（註冊誘因）與貢獻榜歸屬，不是票。

**DiTurst 掛掉時**：快取還在就照快取；快取過期就**降級成匿名**（`ip:`）並在回應 `warning` 說明，**永遠不擋貢獻**。
正見不能因為身份供應商停機而停擺。

---

## 7. 正見的觸點

| 位置 | 改什麼 |
| --- | --- |
| `_shared/actor.ts`（新） | 解析 `agent_name` → `{ actor_id, handle, level }`；驗證＋快取；降級規則。純函式部分可測 |
| `next`／`report`／`verify`／`verifications`／`contribute-handler`／`verify-handler` | 入口先過 `actor.ts`；寫入帶 `actor_id`；去重與排除改看 `actor_id`（剛上線的 `contribution_verify_pool(p_ip_hash)` 改成 `p_actor_id`） |
| `contribution_leaderboard`／`contribution_feed_summary`（SQL） | `GROUP BY actor_id`，顯示 handle |
| `UserProfile.vue` | 「我的貢獻」改用 `actor_id = ditrust:<auth.uid()>`；多一個「代理序號」區塊（呼叫 provision／reveal／rotate） |
| `public/skill.md` | §7 加 `ditrust:<序號>`，講清楚序號只給代理用 |
| `isValidAgentName` | 允許 `diturst:` 前綴（現在的規則擋冒號） |

---

## 8. 順序（每一步可單獨上線）

| # | 誰 | 做什麼 | 改變代理行為嗎 |
| --- | --- | --- | --- |
| 1 | 正見 | `actor_id` 欄位＋回填；`actor.ts` 只認匿名（`ip:`），`diturst:` 前綴先擋並講清楚還沒開放 | 否（**2026-09-19 已上線**） |
| 2 | DiTurst | 四支 `agents-*` Edge Functions ＋ `ditrust` schema ＋ public 包裝 ＋速率限制 | 否（**2026-09-19 上線並驗收**：整合測試 16/16、撤銷 401、擁有者 provision 的 agent_id ＝ auth.uid()；分支 `identity-endpoints`） |
| 3 | 正見 | 解析 `ditrust:<序號>`、驗證快取、寫 `actor_id`；skill.md 加一句 | 否（匿名照舊）（**2026-09-19 上線**：next／report／contribute／verify 入口先過 `resolveActorFromRequest`，agents-verify 快取 5 分鐘，失敗 401／503 不降級） |
| 4 | 正見 | 去重／排除／額度改 `actor_id`（IP 留第二道） | DTrust 代理開始有獨立身份 |
| 5 | 正見 | 個人頁序號區塊、「我的貢獻」改 `actor_id` 關聯 | 否（**2026-09-19 上線**：`ditrust-agent` 端點 link／reveal／rotate 只用 session 信箱；登入即自動連結；feed 支援 `actor_id`） |
| 6 | DiTurst | 貢獻回寫 XP（webhook） | 否 |

第 1 步跟第 2 步互不相依，可以同時開工。

---

## 9. 風險

- **序號外流＝冒名**：撤銷在 DiTurst 做，正見的快取最多延遲幾分鐘。快取 TTL 就是撤銷延遲的上限，別設太長。
- **不能追溯**：連結之前的匿名貢獻沒有證據是誰的，不歸戶。UI 要講明，不然使用者會以為連結了就拿回來。
- **單點**：DiTurst 停機 → 降級匿名，不擋。見 §6。
- **序號被貼進網站**：開戶流程就是為了不讓這件事發生。任何要使用者貼序號的設計都要退回。
- **信箱接管**：兩邊信箱都必須驗證過、正見從 session 取信箱（§4 護欄一）。DiTurst 若開放未驗證信箱註冊，這條就破了。
- 給人看的文字純中文（CLAUDE.md 規範）。
