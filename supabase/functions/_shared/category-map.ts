/**
 * 政見分類：19 個正規值（＝categories 表，migration 20260912000003）＋舊寫法對照。
 * 提交（contribute／report）只收 19 值，舊值回 400 category_invalid 並提示對照；apply 落庫再過一次對照當保險。
 * 改這裡要同步：migration 的 categories 種子、public/skill.md 的分類表。
 */

export const POLICY_CATEGORIES = [
  "交通建設", "都市發展與住宅", "社會福利", "醫療衛生", "教育文化", "經濟發展與產業", "農漁業",
  "環境保護", "能源", "治安消防與防災", "青年與勞工", "性別與人權", "原住民與族群", "體育休閒",
  "行政革新與數位治理", "財政與稅務", "公平正義", "政治議題", "其他",
] as const;
export type PolicyCategory = (typeof POLICY_CATEGORIES)[number];

/** 一句涵蓋說明（與 migration 的 categories.description 同文） */
export const CATEGORY_DESCRIPTIONS: Readonly<Record<PolicyCategory, string>> = {
  "交通建設": "道路、橋梁、大眾運輸、捷運輕軌、鐵路、停車、交通安全與運輸政策",
  "都市發展與住宅": "都市計畫、都更、社會住宅、居住正義、房價與租屋、區域開發、公共空間",
  "社會福利": "長照、托育、身心障礙、弱勢扶助、津貼補助、社福設施",
  "醫療衛生": "醫療資源、公衛、防疫、健保、心理健康、食安",
  "教育文化": "各級教育、幼教、技職、文化藝術、圖書館、語言與文資",
  "經濟發展與產業": "產業政策、招商投資、中小企業、觀光、商圈、就業機會、地方經濟",
  "農漁業": "農業、漁業、畜牧、農地、農產運銷、農漁民福利",
  "環境保護": "空污、水污、廢棄物、生態保育、氣候調適、淨零",
  "能源": "電力、再生能源、核能、節能、能源轉型",
  "治安消防與防災": "警政治安、消防、災害防救、防洪治水、公共安全",
  "青年與勞工": "青年政策、創業、勞動條件、薪資、職訓、工會",
  "性別與人權": "性別平等、婚姻家庭、人權、多元族群平權（非原住民）",
  "原住民與族群": "原住民族政策、族群文化、新住民、客家",
  "體育休閒": "運動場館、體育推廣、休閒設施、公園綠地",
  "行政革新與數位治理": "政府效能、開放資料、數位服務、廉政、組織改造",
  "財政與稅務": "預算、財政紀律、稅制、規費、公共債務",
  "公平正義": "司法改革、轉型正義、分配正義、弱勢權益保障",
  "政治議題": "選制、地方自治、兩岸、國防外交、政黨政治",
  "其他": "上列都不適合時才用",
};

/** 舊寫法 → 正規值（migration 對 policies 既有資料用同一張表） */
export const LEGACY_CATEGORY_MAP: Readonly<Record<string, PolicyCategory>> = {
  "交通": "交通建設",
  "社會": "社會福利",
  "社福": "社會福利",
  "經濟": "經濟發展與產業",
  "經濟發展": "經濟發展與產業",
  "經濟補助": "經濟發展與產業",
  "環境": "環境保護",
  "教育": "教育文化",
  "行政革新": "行政革新與數位治理",
  "居住正義": "都市發展與住宅",
  "治安司法": "治安消防與防災",
};

export function isCanonicalCategory(v: unknown): v is PolicyCategory {
  return typeof v === "string" && (POLICY_CATEGORIES as readonly string[]).includes(v);
}

/** 正規化：正規值原樣；舊寫法換成正規值；其餘（含空值）回 null。 */
export function normalizeCategory(raw: string | null | undefined): PolicyCategory | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (isCanonicalCategory(s)) return s;
  return LEGACY_CATEGORY_MAP[s] ?? null;
}

/** 提交時的錯誤訊息：列出 19 值；舊值另提示對照 */
export function categoryErrorMessage(raw: unknown): string {
  const s = typeof raw === "string" ? raw.trim() : "";
  const hint = LEGACY_CATEGORY_MAP[s] ? `「${s}」是舊寫法，請改為「${LEGACY_CATEGORY_MAP[s]}」。` : "";
  return `${hint}category 只能是這 19 個之一：${POLICY_CATEGORIES.join("／")}`;
}
