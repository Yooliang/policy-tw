# AI 對話頁面架構規劃

## 需求概述

建立一個面向使用者的通用 AI 對話頁面，讓使用者可以：
1. 透過簡單的對話框提交各類資訊
2. 後端自動分類任務類型並路由處理
3. 查看任務執行結果

---

## 現有架構 vs 新架構對比

### 現有架構

```
┌─────────────────────────────────────────────────────────┐
│                    使用者入口                            │
├──────────────────────┬──────────────────────────────────┤
│     AdminAI.vue      │       VerifyContent.vue          │
│     (管理員專用)      │       (政見驗證專用)              │
│  ┌────────────────┐  │   ┌────────────────────────┐     │
│  │ 候選人搜尋     │  │   │ 輸入政見內容/網址      │     │
│  │ 政見進度更新   │  │   │ Gemini 分析            │     │
│  │ 任務歷史      │  │   │ 信心度 >= 0.9 可貢獻   │     │
│  └────────────────┘  │   └────────────────────────┘     │
└──────────┬───────────┴──────────────┬───────────────────┘
           │                          │
           ▼                          ▼
    ┌──────────────┐          ┌──────────────┐
    │  ai-search   │          │  ai-verify   │
    │  (Claude)    │          │  (Gemini)    │
    └──────────────┘          └──────────────┘
```

**問題：**
- 功能分散在不同頁面
- 管理員和使用者入口分離
- 缺乏統一的任務分類機制

### 新架構

```
┌─────────────────────────────────────────────────────────┐
│                    AIChat.vue                            │
│                  (通用對話頁面)                          │
│  ┌───────────────────────────────────────────────────┐  │
│  │                   對話輸入框                       │  │
│  │  "請查找台北市長候選人"                            │  │
│  │  "這是蔣萬安的政見新聞：https://..."              │  │
│  │  "請驗證這個政策是否屬實：..."                    │  │
│  └───────────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────────┐  │
│  │                   任務歷史                         │  │
│  │  ├── 候選人搜尋 (完成) ──► 查看結果               │  │
│  │  ├── 政見匯入 (處理中)                            │  │
│  │  └── 政策驗證 (待處理)                            │  │
│  └───────────────────────────────────────────────────┘  │
└──────────────────────────┬──────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────┐
│                    ai-classify                           │
│                  (新增: 任務分類器)                      │
│  ┌───────────────────────────────────────────────────┐  │
│  │  輸入分析：                                        │  │
│  │  - 是否包含網址？                                  │  │
│  │  - 是否為搜尋請求？                                │  │
│  │  - 是否包含政見內容？                              │  │
│  │  - 是否為驗證請求？                                │  │
│  └───────────────────────────────────────────────────┘  │
│                          │                               │
│     ┌────────────────────┼────────────────────┐         │
│     ▼                    ▼                    ▼         │
│  candidate_search   policy_import      policy_verify    │
│  (搜尋候選人)       (匯入政見)         (驗證政見)       │
└─────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────┐
│                    ai_prompts 表                         │
│  task_type:                                              │
│  - candidate_search (搜尋候選人)                         │
│  - policy_import (匯入政見) ← 新增                       │
│  - policy_verify (驗證政見)                              │
│  - progress_tracking (進度追蹤)                          │
│  - user_contribution (使用者貢獻) ← 新增                 │
└─────────────────────────────────────────────────────────┘
```

---

## 任務分類邏輯

### 分類決策樹

```
使用者輸入
    │
    ├── 包含「搜尋」「查找」「找」+ 地區/職位？
    │   └── YES → candidate_search (候選人搜尋)
    │
    ├── 包含新聞網址 + 候選人相關內容？
    │   └── YES → policy_import (政見匯入)
    │           └── 子流程：提取政治人物、政見內容
    │
    ├── 包含「驗證」「查核」「是否屬實」？
    │   └── YES → policy_verify (政見驗證)
    │
    ├── 包含政策進度相關內容？
    │   └── YES → progress_tracking (進度追蹤)
    │
    └── 其他
        └── user_contribution (使用者貢獻)
            └── 需要人工審核
```

### 分類器實作

```typescript
// supabase/functions/ai-classify/index.ts

interface ClassificationResult {
  task_type: 'candidate_search' | 'policy_import' | 'policy_verify' |
             'progress_tracking' | 'user_contribution';
  confidence: number;
  extracted_params: {
    region?: string;
    position?: string;
    politician_name?: string;
    url?: string;
    election_year?: number;
  };
  requires_review: boolean;
}

async function classifyInput(input: string, url?: string): Promise<ClassificationResult> {
  // 1. 規則優先判斷
  if (hasSearchKeywords(input)) {
    return {
      task_type: 'candidate_search',
      confidence: 0.9,
      extracted_params: extractSearchParams(input),
      requires_review: false
    };
  }

  if (url && isNewsUrl(url)) {
    return {
      task_type: 'policy_import',
      confidence: 0.8,
      extracted_params: { url },
      requires_review: true  // 新聞需要審核
    };
  }

  if (hasVerifyKeywords(input)) {
    return {
      task_type: 'policy_verify',
      confidence: 0.85,
      extracted_params: {},
      requires_review: false
    };
  }

  // 2. 無法判斷時使用 AI 分類
  return await aiClassify(input);
}
```

---

## 新增資料表欄位

### ai_prompts 表擴充

```sql
-- 新增 task_type 選項
ALTER TABLE ai_prompts
DROP CONSTRAINT ai_prompts_task_type_check;

ALTER TABLE ai_prompts
ADD CONSTRAINT ai_prompts_task_type_check
CHECK (task_type IN (
  'candidate_search',
  'policy_search',
  'policy_verify',
  'progress_tracking',
  'policy_import',      -- 新增：政見匯入
  'user_contribution'   -- 新增：使用者貢獻
));

-- 新增欄位
ALTER TABLE ai_prompts ADD COLUMN IF NOT EXISTS
  source_url TEXT,              -- 來源網址
  requires_review BOOLEAN DEFAULT FALSE,  -- 是否需要人工審核
  reviewed_by UUID REFERENCES auth.users(id),
  reviewed_at TIMESTAMPTZ,
  review_notes TEXT;
```

---

## 頁面設計

### AIChat.vue 元件結構

```vue
<template>
  <div class="ai-chat-page">
    <!-- 頁首說明 -->
    <header class="chat-header">
      <h1>AI 助手</h1>
      <p>提交選舉資訊、搜尋候選人、驗證政見</p>
    </header>

    <!-- 對話輸入區 -->
    <section class="chat-input-section">
      <textarea
        v-model="userInput"
        placeholder="例如：請查找 2026 年台北市長候選人..."
        rows="4"
      />
      <input
        v-model="sourceUrl"
        type="url"
        placeholder="相關網址（選填）"
      />
      <button @click="submitTask" :disabled="submitting">
        {{ submitting ? '處理中...' : '提交' }}
      </button>
    </section>

    <!-- 任務狀態提示 -->
    <section v-if="currentTask" class="current-task">
      <TaskStatusCard :task="currentTask" />
    </section>

    <!-- 任務歷史 -->
    <section class="task-history">
      <h2>我的任務</h2>
      <TaskList
        :tasks="myTasks"
        @view="viewTaskResult"
      />
    </section>

    <!-- 結果展示 Modal -->
    <TaskResultModal
      v-if="selectedTask"
      :task="selectedTask"
      @close="selectedTask = null"
    />
  </div>
</template>
```

### 頁面入口

在 Footer.vue 新增入口：

```vue
<router-link to="/ai-chat" class="footer-link">
  <SparklesIcon class="w-5 h-5" />
  AI 助手
</router-link>
```

路由配置：
```typescript
// router/index.ts
{
  path: '/ai-chat',
  name: 'AIChat',
  component: () => import('@/pages/AIChat.vue'),
  meta: {
    title: 'AI 助手',
    requiresAuth: false  // 公開訪問，但提交需登入
  }
}
```

---

## Edge Function 設計

### 新增 ai-classify

```typescript
// supabase/functions/ai-classify/index.ts

import { createClient } from '@supabase/supabase-js';

const SEARCH_KEYWORDS = ['搜尋', '查找', '找', '搜索', '列出', '有哪些'];
const VERIFY_KEYWORDS = ['驗證', '查核', '是否屬實', '真的嗎', '確認'];
const REGION_PATTERN = /(台北|新北|桃園|台中|台南|高雄|基隆|新竹|嘉義|苗栗|彰化|南投|雲林|屏東|宜蘭|花蓮|台東|澎湖|金門|連江)(市|縣)?/g;
const POSITION_PATTERN = /(縣市長|市長|縣長|議員|立委|總統|鄉鎮市長|村里長)/g;

Deno.serve(async (req) => {
  const { input, url } = await req.json();

  // 提取參數
  const regions = input.match(REGION_PATTERN) || [];
  const positions = input.match(POSITION_PATTERN) || [];
  const hasUrl = !!url;

  // 判斷任務類型
  let task_type: string;
  let confidence: number;
  let requires_review = false;

  if (SEARCH_KEYWORDS.some(k => input.includes(k)) && (regions.length > 0 || positions.length > 0)) {
    task_type = 'candidate_search';
    confidence = 0.9;
  } else if (hasUrl && isNewsUrl(url)) {
    task_type = 'policy_import';
    confidence = 0.8;
    requires_review = true;
  } else if (VERIFY_KEYWORDS.some(k => input.includes(k))) {
    task_type = 'policy_verify';
    confidence = 0.85;
  } else {
    task_type = 'user_contribution';
    confidence = 0.6;
    requires_review = true;
  }

  // 建立 ai_prompts 記錄
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );

  const { data: prompt, error } = await supabase
    .from('ai_prompts')
    .insert({
      task_type,
      prompt_template: input,
      parameters: {
        regions,
        positions,
        url,
        election_year: 2026
      },
      source_url: url,
      requires_review,
      status: 'pending',
      priority: requires_review ? 5 : 7,
      confidence
    })
    .select('id')
    .single();

  return new Response(JSON.stringify({
    success: true,
    prompt_id: prompt?.id,
    task_type,
    confidence,
    requires_review,
    message: getStatusMessage(task_type, requires_review)
  }));
});

function getStatusMessage(task_type: string, requires_review: boolean): string {
  if (requires_review) {
    return '已收到您的提交，將在審核後處理';
  }
  switch (task_type) {
    case 'candidate_search':
      return '正在搜尋候選人資訊...';
    case 'policy_verify':
      return '正在驗證政見內容...';
    default:
      return '任務已建立，請稍候...';
  }
}
```

---

## 與現有架構的整合

### 整合策略

| 現有功能 | 整合方式 |
|---------|---------|
| AdminAI 候選人搜尋 | 保留，AIChat 共用相同後端 |
| AdminAI 政見更新 | 保留，僅管理員可用 |
| VerifyContent | 合併到 AIChat，保留獨立頁面作為簡化入口 |
| ai-search | 不變，AIChat 透過 ai-classify 路由到此 |
| ai-verify | 不變，AIChat 透過 ai-classify 路由到此 |

### 差異處理

| 項目 | AdminAI | AIChat | 說明 |
|------|---------|--------|------|
| 認證 | 需要管理員 | 公開提交 | AIChat 提交後標記 requires_review |
| 自動匯入 | 可直接匯入 | 需審核 | 非管理員提交的資料需審核 |
| 批次功能 | 有 | 無 | 批次操作保留在 AdminAI |
| 任務類型 | 指定 | 自動分類 | AIChat 由系統判斷類型 |

### 修改 ai-search 支援公開提交

```typescript
// 修改 ai-search/index.ts

// 區分管理員和一般使用者
const isAdmin = user_profile?.is_admin === true;

const { data: prompt } = await supabase.from('ai_prompts').insert({
  task_type: 'candidate_search',
  prompt_template: buildPrompt(params),
  parameters: params,
  status: 'pending',
  priority: isAdmin ? 8 : 5,  // 管理員優先
  requires_review: !isAdmin,   // 非管理員需審核
  created_by: user?.id
}).select('id').single();
```

---

## 實作步驟

### Phase 1: 資料庫準備
1. ✅ 建立資料庫結構文件
2. ⏳ 擴充 ai_prompts 表（新增 task_type、requires_review 欄位）

### Phase 2: Edge Function
3. ⏳ 建立 ai-classify Edge Function
4. ⏳ 修改 ai-search 支援公開提交
5. ⏳ 修改 ai-verify 整合到統一流程

### Phase 3: 前端頁面
6. ⏳ 建立 AIChat.vue 頁面
7. ⏳ 建立相關元件（TaskStatusCard, TaskList, TaskResultModal）
8. ⏳ 在 Footer 新增入口

### Phase 4: 整合測試
9. ⏳ 測試各類輸入的分類準確度
10. ⏳ 測試任務執行流程
11. ⏳ 測試結果展示

---

## 預期使用情境

### 情境 1: 搜尋候選人
```
使用者輸入: "請幫我找 2026 年高雄市長候選人"

系統處理:
1. ai-classify 識別為 candidate_search
2. 提取參數: region=高雄市, position=縣市長, year=2026
3. 建立 ai_prompts 記錄
4. policy-ai 服務處理任務
5. 使用者查看結果
```

### 情境 2: 提交新聞
```
使用者輸入: "這是關於蔣萬安的政見新聞"
網址: https://udn.com/news/story/...

系統處理:
1. ai-classify 識別為 policy_import
2. 標記 requires_review = true
3. 建立待審核任務
4. 管理員審核後處理
5. 匯入政見到資料庫
```

### 情境 3: 驗證政見
```
使用者輸入: "蔣萬安說要蓋捷運到內湖，這是真的嗎？"

系統處理:
1. ai-classify 識別為 policy_verify
2. 呼叫 ai-verify (Gemini)
3. 返回驗證結果和信心度
4. 使用者查看分析報告
```

---

## 安全考量

1. **速率限制**
   - IP 每日 20 次提交
   - 使用者每日 50 次提交

2. **內容過濾**
   - 過濾無意義或惡意輸入
   - 檢測垃圾訊息模式

3. **審核機制**
   - 非管理員提交標記 requires_review
   - 管理員可批量審核

4. **資料驗證**
   - 網址白名單（僅允許新聞網站）
   - 政治人物名稱驗證

---

## 結論

這個新架構將：
1. **統一入口** - 使用者無需區分功能類型
2. **智能分類** - 後端自動路由到正確處理流程
3. **保持相容** - 現有 AdminAI 功能不受影響
4. **擴展性** - 易於新增任務類型

建議按 Phase 順序實作，優先完成資料庫擴充和核心 Edge Function。
