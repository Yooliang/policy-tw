/**
 * 號次重複檢查的 TS 側（2026-10-08，migration 20261008151000_cand_no_dup_check.sql）。
 *
 * 規則只在 SQL 一份（cand_no_dup_conflicts／cand_no_dup_system_check）：同一個號次單位（縣市長＝縣市、縣市議員＝選舉區、
 * 鄉鎮市長與區長＝鄉鎮市區、村里長＝村里）裡跟已上線或等票中的另一位同號，系統票 not_supported（+1）。
 * 這是內部一致性檢查，不核對來源，不牴觸 09-24 的名冊例外範圍。這裡只放 model 前綴與給驗證者看的說明。
 */
export const CAND_NO_DUP_MODEL_PREFIX = "policy-tw/cand-no-dup";

/** 驗證項（/next 的 verify）給的 cand_no_check：系統發現的衝突攤給驗證者看，不給系統退件權 */
export function candNoCheckForVerify(state: Record<string, unknown> | null | undefined, candNo: unknown): Record<string, unknown> {
  const st = state ?? {};
  return {
    conflict: `系統比對號次單位：${String(st.reason ?? `號次 ${String(candNo ?? "?")} 與同一個號次單位的另一位重複`)}。`,
    conflicts: Array.isArray(st.conflicts) ? st.conflicts : [],
    unit: st.unit ?? null,
    question: "同一個號次單位（每個選舉區、村里、鄉鎮各自從 1 編起）不會有兩位同號，所以這一筆和衝突的另一位至少有一個號次抄錯。請打開 source_urls 的公告，找到本人那一格：" +
      "公告上他的號次等於 payload.cand_no → 投 agree（note 寫公告頁碼與他是幾號，並指出衝突的另一位哪裡錯了）；公告上是別的號次 → 投 disagree，note 寫公告上的號次與頁碼。" +
      "這一票不是系統反對：系統只是多要一張人票（目標 +1），不會退件。",
  };
}
