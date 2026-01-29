-- 允許寫入 electoral_district_areas 表
-- 注意：生產環境應該限制只有特定角色可以寫入

CREATE POLICY "Allow public insert on electoral_district_areas"
  ON electoral_district_areas FOR INSERT
  WITH CHECK (true);

CREATE POLICY "Allow public update on electoral_district_areas"
  ON electoral_district_areas FOR UPDATE
  USING (true);

CREATE POLICY "Allow public delete on electoral_district_areas"
  ON electoral_district_areas FOR DELETE
  USING (true);
