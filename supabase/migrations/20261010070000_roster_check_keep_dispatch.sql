-- 名單清查任務不因單筆參選紀錄落庫被收回（工作單 Yooliang/policy-ops#57；日本站同一個問題在 policy-tw #555 已修，這支照同一個做法）
--
-- 名單清查（auto:roster_check:<單位>）是一題多份：代理照名冊一位一筆交 candidacy（缺人時還有 politician、correction），
-- 交件都帶同一個 task_id。原本 contributions_drop_dispatch 只看「轉成 applied」，第一筆參選紀錄一落庫就把整件清查收回，
-- 下一輪 seed（10 分鐘）發現缺口還在又開回來、排到隊尾。2026-10-10 唯讀查正式庫：651 個清查任務、189 次 closed 全是這條路，
-- 其中 174 次接著 reopened，中位數間隔 6.3 分鐘。
--
-- 改法：不動 task_dispatches_drop_applied（日本站複本有 drift 測試），只改觸發器的 WHEN——
-- auto:roster_check 的任務只在「清查回報本身」（roster_check）或「查無／無異動」（no_change）落庫時收回；
-- 其他型別（candidacy、politician、correction）落庫不收回，交給 seed 依缺口在不在決定。其他任務一律照舊。
DROP TRIGGER IF EXISTS contributions_drop_dispatch ON contributions;
CREATE TRIGGER contributions_drop_dispatch AFTER UPDATE OF status ON contributions
  FOR EACH ROW WHEN (NEW.status = 'applied' AND OLD.status IS DISTINCT FROM 'applied'
                     AND NOT (NEW.task_id LIKE 'auto:roster_check:%' AND NEW.contribution_type NOT IN ('roster_check', 'no_change')))
  EXECUTE FUNCTION task_dispatches_drop_applied();
