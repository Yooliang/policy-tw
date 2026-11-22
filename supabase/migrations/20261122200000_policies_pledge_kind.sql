-- 政見新增「性質」欄 pledge_kind（2026-11-22 維護者裁示，選 B：公報上的口號型政見也收，標成原則宣示）
--
-- 背景：鄉鎮市民代表等還沒抄到政見的人，公報政見欄寫的多是「理性問政、強力監督、熱誠服務」這類口號。
-- 代理依舊規則（沒有具體做法不交件）回報查無，這些人永遠沒有政見。改成口號也收，但網站要能與具體承諾分開顯示。
--
-- 只加欄位、不動既有資料：既有政見一律預設 'specific'（具體承諾）；新交件可標 'principle'（原則宣示）。
--   specific  具體承諾：有具體標的、做法或數字
--   principle 原則宣示：只有口號、原則、態度表述（例：「理性問政、強力監督、熱誠服務」）
--
-- 日本站 policy_jp 不跟（維護者未裁示；之後要跟另開 migration）。
--
-- 回滾：先確認前端與程式都不再讀 pledge_kind（grep pledge_kind），再
--   ALTER TABLE public.policies DROP COLUMN IF EXISTS pledge_kind;
-- 欄位帶 NOT NULL DEFAULT 常數，PostgreSQL 11 起加欄不重寫整張表。

ALTER TABLE public.policies
  ADD COLUMN IF NOT EXISTS pledge_kind text NOT NULL DEFAULT 'specific';

ALTER TABLE public.policies DROP CONSTRAINT IF EXISTS policies_pledge_kind_check;
ALTER TABLE public.policies
  ADD CONSTRAINT policies_pledge_kind_check CHECK (pledge_kind IN ('specific', 'principle'));

COMMENT ON COLUMN public.policies.pledge_kind IS
  '政見性質：specific 具體承諾（有具體標的、做法或數字；預設，既有資料全是這個）／principle 原則宣示（公報上只有口號、原則、態度表述，例：「理性問政、強力監督、熱誠服務」）。2026-11-22 維護者裁示：口號型政見也收，標成原則宣示，網站顯示時與具體承諾分開。';
