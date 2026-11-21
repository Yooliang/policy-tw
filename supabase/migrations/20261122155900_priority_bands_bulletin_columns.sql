-- 抄公報抬高的前置：只加欄位（2026-11-22，主 migration 20261122160000_priority_bands_bulletin_first.sql 用）
-- 同 20261121192900：ADD COLUMN 持 ACCESS EXCLUSIVE 鎖到交易結束，不跟主 migration 的一次性重算放同一個交易。
SET LOCAL lock_timeout = '5s';

ALTER TABLE queue_settings ADD COLUMN IF NOT EXISTS priority_bands_bulletin_applied_at TIMESTAMPTZ;
