-- 採樣頻率從 4 小時改成 1 小時。
--
-- 原本選 4 小時是因為這些指標變化慢。但專案剛發到社群，正在觀察外部參與的反應，
-- 一小時的解析度才看得出「什麼時候有人來、來了之後多久有動作」。
--
-- 資料量不是問題：一年約 8,760 筆，每筆十幾個整數。真的嫌多再加清理排程，
-- 現在做是過早最佳化。

SELECT cron.unschedule('pipeline-snapshot-4h');
SELECT cron.schedule('pipeline-snapshot-hourly', '0 * * * *', 'SELECT pipeline_take_snapshot();');

-- 改完立刻補一筆，不必等下一個整點
SELECT pipeline_take_snapshot();
