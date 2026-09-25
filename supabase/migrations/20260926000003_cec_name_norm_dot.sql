-- cec_name_norm 也去掉半形句點：NFKC 會把全形「．」變成「.」，原本的移除清單只有全形，原住民名的間隔號會殘留。
-- TS 版（_shared/cec-sync.ts 的 cecNameNorm）同步。
CREATE OR REPLACE FUNCTION cec_name_norm(p TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT regexp_replace(translate(normalize(COALESCE(p, ''), NFKC), '臺黄', '台黃'), '[\s·．.・‧•]', '', 'g')
$$;
