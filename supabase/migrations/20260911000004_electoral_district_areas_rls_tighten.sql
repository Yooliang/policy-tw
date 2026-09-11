-- electoral_district_areas 原本 INSERT/UPDATE/DELETE 政策皆為 true（匿名可寫）。程式碼只讀，收斂為 service_role 寫入。

DO $$ DECLARE p record; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename='electoral_district_areas' AND cmd IN ('INSERT','UPDATE','DELETE','ALL') LOOP
    EXECUTE format('DROP POLICY %I ON public.electoral_district_areas', p.policyname);
  END LOOP;
END $$;
CREATE POLICY "Service role write" ON public.electoral_district_areas FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
