"""
內政部政黨名冊 → parties／party_aliases 的資料段（#346 第一階段）與前端用的 lib/party-seed.json。

  python scripts/fetch-moi-parties.py --fetch 名冊.xls                              # 抓官方名冊（全部狀態），存成 xls
  python scripts/fetch-moi-parties.py --from 名冊.xls --seed lib/party-seed.json --sql 資料段.sql
  python scripts/fetch-moi-parties.py --seed lib/party-seed.json --sql 資料段.sql    # 兩步一起做（不留 xls）

來源：內政部政黨資訊網「查政黨」https://party.moi.gov.tw/PartyMain.aspx?n=16100&sms=13073 ，
狀態選「全部」按「匯出」（ASP.NET 表單，回傳的其實是 Excel 97 的 xls，副檔名寫 ods）。
欄位：政黨編號、政黨名稱、負責人、成立日期、備案日期、地址、電話、政黨狀態（一般／撤銷備案／自行解散／失聯／廢止備案）。
2026-10-06 擷取 397 個政黨（一般 80、廢止備案 229、自行解散 86、撤銷備案 2）。

怎麼對到我們資料裡的政黨文字（politicians.party、candidacy 交件的 party）：
- 名冊上每一個政黨一列（含已解散、廢止的；同名重新備案的兩個政黨各一列），名稱就是它的正式寫法。
  名冊名稱後面帶的註記（例「中華統一促進黨（115年8月7日內政部向憲法法庭聲請違憲解散）」）不是名稱，
  名稱拿掉括號那段，原文照抄進 moi_name。
- 寫法對照（party_aliases）一律比「正規化後的字」：全形轉半形（NFKC）、去掉所有空白、「臺」當「台」。
  SQL 的 party_alias_key() 與前端 lib/parties.ts 的 partyAliasKey() 是同一套，測試盯兩邊一致。
- 同名重新備案的（台灣民主黨、商工統一促進會），名稱只對到狀態「一般」的那一個。
- 下面 MANUAL_ALIASES 是名冊名稱以外、資料裡真的出現過的寫法，每一條都要寫理由；
  INDEPENDENT 是「無黨籍」那一族——日本站一樣，無黨籍不是一個政黨、不建列，人物與參選紀錄的 party_id 是空的。
- UNREGISTERED 是資料裡出現、名冊（擷取日）查無此名稱的政黨：照「改名視為新的一筆」各建一列、moi_no 空著。
  多半是已經改名或解散的舊名（2024 立委選舉政黨名單上的名字），改成哪一個沒有官方根據前不連起來。

有效期間（valid_from／valid_to）：這個名稱的有效期間，改名視為新的一筆。
- valid_from 填名冊的「成立日期」：名冊只登記現名，沒有改名紀錄，所以改過名的政黨在查到改名日之前，
  現名這一列的 valid_from 留空（只有 RENAMED 裡列的才知道改過名），舊名那一列放成立日期。
- valid_to 一律空著：名冊的解散、廢止沒有日期，只有狀態（moi_status）——空的 valid_to 不代表還在。

名冊不常變，不排程：要更新就重跑這支、另寫一支 migration 補差異（parties 用固定的 id，不要重排）。
"""
import argparse
import http.cookiejar
import html
import json
import re
import sys
import unicodedata
import urllib.parse
import urllib.request
from datetime import date

LIST_URL = "https://party.moi.gov.tw/PartyMain.aspx?n=16100&sms=13073"
UA = {"User-Agent": "policy-tw party registry fetcher (https://github.com/Yooliang/policy-tw)"}

# 「無黨籍」那一族：不是政黨，party_id 留空（日本站 v0.3 同一個決定：「無所属」不是 parties 的一列）
INDEPENDENT = {
    "無黨籍": "中選會以外最常見的寫法",
    "無黨籍及未經政黨推薦": "中選會候選人名冊的寫法（2022 整批匯入的 12,712 位都是這個）",
    "無黨籍及未經政黨推薦者": "中選會名冊寫法「無黨籍及未經政黨推薦」偶爾多一個「者」",
    "未經政黨推薦": "中選會名冊寫法「無黨籍及未經政黨推薦」的後半段",
    "無": "交件只寫一個「無」（2026-10-06 資料裡 7 位、交件 22 筆，都是無黨籍的意思）",
    "無黨": "無黨籍的簡寫",
}

# 名冊名稱以外、資料裡出現過的寫法 → 名冊上的哪個政黨（用名冊的正式名稱指）。kind：short 簡稱／variant 異寫
MANUAL_ALIASES = [
    ("國民黨", "中國國民黨", "short", "通稱；名冊另有「台灣國民黨」（政黨編號 127），只寫「國民黨」指的是中國國民黨"),
    ("民進黨", "民主進步黨", "short", "通稱"),
    ("民眾黨", "台灣民眾黨", "short", "通稱；名冊另有「中國民眾黨」（政黨編號 10），只寫「民眾黨」指的是台灣民眾黨（沿用 identity-normalize.ts 的對照）"),
    ("綠黨", "台灣綠黨", "short", "通稱；名冊上的正式名稱是「台灣綠黨」（政黨編號 79）"),
    ("台灣基進黨", "台灣基進", "variant", "名冊上的正式名稱沒有「黨」字（政黨編號 303）"),
]

# 改名（改名視為新的一筆）：舊名建一列、現名那一列的 predecessor 指過去。要有官方根據才列
RENAMED = [
    {
        "old": "台灣團結聯盟",
        "new": "台聯黨",
        "evidence_url": "https://party.moi.gov.tw/PartyMainContent.aspx?n=16100&sms=13073&s=154",
        "evidence": "內政部政黨資訊網「台聯黨」（政黨編號 95，成立日期 2001-08-12＝台灣團結聯盟建黨日）的黨徽圖檔名稱是「95_台灣團結聯盟logo」；名冊沒有改名日，兩列的界線日期待查",
    },
]

# 資料裡出現、名冊（擷取日）查無此名稱的政黨名稱：各建一列、moi_no 空著
UNREGISTERED = {
    "制度救世島": "2024 立委選舉的政黨名稱；內政部政黨名冊（擷取日）查無此名稱，可能已改名或解散，待查證",
    "臺灣雙語無法黨": "2024 立委選舉的政黨名稱；內政部政黨名冊（擷取日）查無此名稱。名冊上有「臺灣SoR無法黨」（政黨編號 366），是不是改名沒有官方根據，先不連起來",
    "共和黨": "資料裡只有 1 位；內政部政黨名冊（擷取日）查無此名稱（名冊上有幾個名字帶「共和黨」的，都不是這個寫法），待查證",
    "新華勞動黨": "資料裡只有 1 位；內政部政黨名冊（擷取日）查無此名稱，待查證",
    "台灣革命黨": "資料裡只有 1 位；內政部政黨名冊（擷取日）查無此名稱，待查證",
}

# 簡稱（畫面用）：只放通稱真的被資料用到的那幾個，其餘沒有簡稱
SHORT_NAMES = {"中國國民黨": "國民黨", "民主進步黨": "民進黨", "台灣民眾黨": "民眾黨", "台灣綠黨": "綠黨"}

STATUSES = ["一般", "撤銷備案", "自行解散", "失聯", "廢止備案"]


def alias_key(text: str) -> str:
    """跟 SQL party_alias_key()、前端 partyAliasKey() 同一套：NFKC → 去空白 → 臺當台"""
    s = unicodedata.normalize("NFKC", text or "")
    s = re.sub(r"\s+", "", s)
    return s.replace("臺", "台")


def roc_date(text: str) -> str | None:
    """民國前18年11月24日 → 1894-11-24；民國85年01月25日 → 1996-01-25；空的回 None"""
    m = re.match(r"^民國(前)?(\d+)年(\d+)月(\d+)日$", (text or "").strip())
    if not m:
        return None
    year = 1912 - int(m.group(2)) if m.group(1) else 1911 + int(m.group(2))
    return date(year, int(m.group(3)), int(m.group(4))).isoformat()


def fetch_xls(path: str) -> None:
    cj = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
    page = opener.open(urllib.request.Request(LIST_URL, headers=UA), timeout=60).read().decode("utf-8", "replace")
    fields = {}
    for m in re.finditer(r'<input[^>]*type="hidden"[^>]*>', page):
        name = re.search(r'name="([^"]+)"', m.group(0))
        value = re.search(r'value="([^"]*)"', m.group(0))
        if name:
            fields[name.group(1)] = html.unescape(value.group(1)) if value else ""
    prefix = "ctl00$ContentPlaceHolder1$"
    for k in ["TB_POLITICAL_NO", "TB_GROUP_NAME", "TB_PRESIDENT_NAME", "TB_GROUP_CREATE_DATE_S", "TB_GROUP_CREATE_DATE_E",
              "TB_GROUP_PERMIT_DATE_S", "TB_GROUP_PERMIT_DATE_E"]:
        fields[prefix + k] = ""
    fields[prefix + "DDL_GROUP_STATUS"] = ""  # 全部狀態（預設只有「一般」）
    fields[prefix + "BTN_Export_Ods"] = "匯出Ods"
    req = urllib.request.Request(LIST_URL, data=urllib.parse.urlencode(fields).encode(),
                                 headers={**UA, "Content-Type": "application/x-www-form-urlencoded", "Referer": LIST_URL})
    body = opener.open(req, timeout=120).read()
    with open(path, "wb") as f:
        f.write(body)
    print(f"已存 {path}（{len(body)} bytes）", file=sys.stderr)


def read_registry(path: str) -> list[dict]:
    import xlrd  # 名冊是 Excel 97 格式

    sheet = xlrd.open_workbook(path).sheet_by_index(0)
    header = [str(sheet.cell_value(0, c)).strip() for c in range(sheet.ncols)]
    col = {name: header.index(name) for name in ["政黨編號", "政黨名稱", "成立日期", "政黨狀態"]}
    rows = []
    for r in range(1, sheet.nrows):
        cell = lambda name: str(sheet.cell_value(r, col[name])).strip()
        raw_no = cell("政黨編號")
        if not raw_no:
            continue
        status = cell("政黨狀態")
        if status not in STATUSES:
            raise SystemExit(f"政黨編號 {raw_no} 的狀態「{status}」不在已知清單裡，先看一下名冊改了什麼")
        moi_name = cell("政黨名稱")
        rows.append({
            "moi_no": int(float(raw_no)),
            "moi_name": moi_name,
            # 名稱後面的全形括號是內政部加的註記（聲請解散之類），不是名稱的一部分
            "name": re.sub(r"（[^（）]*）$", "", moi_name).strip(),
            "moi_status": status,
            "founded_on": roc_date(cell("成立日期")),
        })
    rows.sort(key=lambda x: x["moi_no"])
    return rows


def build(registry: list[dict], fetched_on: str) -> dict:
    parties = []
    by_key: dict[str, list[dict]] = {}
    for row in registry:
        party = {
            # 名冊上的政黨 id＝政黨編號（穩定、網址 /party/:id 用）；名冊外的列從 10001 起
            "id": row["moi_no"],
            "name": row["name"],
            "short_name": SHORT_NAMES.get(row["name"]),
            "moi_no": row["moi_no"],
            "moi_name": row["moi_name"],
            "moi_status": row["moi_status"],
            "valid_from": row["founded_on"],
            "valid_to": None,
            "predecessor_id": None,
            "note": None,
        }
        parties.append(party)
        by_key.setdefault(alias_key(party["name"]), []).append(party)

    def registered(name: str) -> dict:
        found = by_key.get(alias_key(name), [])
        active = [p for p in found if p["moi_status"] == "一般"] or found
        if len(active) != 1:
            raise SystemExit(f"名冊上找不到唯一的「{name}」（{len(found)} 個）")
        return active[0]

    # 改名：舊名另建一列，現名的 valid_from 改成未知（名冊的成立日期是建黨日，不是改名日）
    extra_id = 10001  # 名冊外的列用 10001 起跳，跟政黨編號分開
    for r in RENAMED:
        new = registered(r["new"])
        old = {
            "id": extra_id, "name": r["old"], "short_name": None, "moi_no": None, "moi_name": None, "moi_status": None,
            "valid_from": new["valid_from"], "valid_to": None, "predecessor_id": None,
            "note": f"改名為「{new['name']}」。{r['evidence']}",
            "evidence_url": r["evidence_url"],
        }
        extra_id += 1
        new["predecessor_id"] = old["id"]
        new["valid_from"] = None
        new["note"] = f"前身「{r['old']}」。{r['evidence']}"
        new["evidence_url"] = r["evidence_url"]
        parties.append(old)
        by_key.setdefault(alias_key(old["name"]), []).append(old)
    for name, note in UNREGISTERED.items():
        if alias_key(name) in by_key:
            raise SystemExit(f"「{name}」名冊上其實有，從 UNREGISTERED 拿掉")
        p = {"id": extra_id, "name": name, "short_name": None, "moi_no": None, "moi_name": None, "moi_status": None,
             "valid_from": None, "valid_to": None, "predecessor_id": None, "note": note}
        extra_id += 1
        parties.append(p)
        by_key.setdefault(alias_key(name), []).append(p)

    aliases: dict[str, dict] = {}

    def add(alias: str, party_id: int | None, kind: str, note: str | None) -> None:
        key = alias_key(alias)
        if key in aliases:
            raise SystemExit(f"寫法「{alias}」重複對照")
        aliases[key] = {"alias_key": key, "alias": alias, "party_id": party_id, "kind": kind, "note": note}

    for key, group in sorted(by_key.items()):
        active = [p for p in group if p["moi_status"] == "一般"] or [p for p in group if p["moi_status"] is None] or group
        target = active[0] if len(active) == 1 else max(active, key=lambda p: p["moi_no"] or 0)
        note = None
        if len(group) > 1:
            note = "同名的政黨不只一個（" + "、".join(f"政黨編號 {p['moi_no']} {p['moi_status']}" for p in group) + "），對到狀態一般的那一個"
        add(target["name"], target["id"], "name", note)
    for alias, target_name, kind, note in MANUAL_ALIASES:
        add(alias, registered(target_name)["id"], kind, note)
    for alias, note in INDEPENDENT.items():
        add(alias, None, "independent", note)

    return {
        "source": LIST_URL,
        "fetched_on": fetched_on,
        "parties": parties,
        "aliases": sorted(aliases.values(), key=lambda a: a["alias_key"]),
    }


def sql_literal(v) -> str:
    if v is None:
        return "NULL"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, int):
        return str(v)
    return "'" + str(v).replace("'", "''") + "'"


def to_sql(seed: dict) -> str:
    out = [
        f"-- ↓↓↓ 資料段：scripts/fetch-moi-parties.py 產生，不要手改（內政部政黨資訊網 政黨名冊（{seed['source']}），擷取日 {seed['fetched_on']}）",
        f"-- 政黨 {len(seed['parties'])} 列（名冊 {sum(1 for p in seed['parties'] if p['moi_no'] is not None)}、名冊外 {sum(1 for p in seed['parties'] if p['moi_no'] is None)}）、寫法對照 {len(seed['aliases'])} 列",
        "INSERT INTO parties (id, name, short_name, moi_no, moi_name, moi_status, valid_from, valid_to, note) OVERRIDING SYSTEM VALUE VALUES",
    ]
    rows = [
        "(" + ",".join(sql_literal(p[k]) for k in ["id", "name", "short_name", "moi_no", "moi_name", "moi_status", "valid_from", "valid_to", "note"]) + ")"
        for p in seed["parties"]
    ]
    out.append(",\n".join(rows) + "\nON CONFLICT (id) DO NOTHING;")
    links = [p for p in seed["parties"] if p["predecessor_id"] is not None]
    for p in links:
        out.append(f"UPDATE parties SET predecessor_id = {p['predecessor_id']} WHERE id = {p['id']};")
    # 改名的根據（內政部該政黨頁）：舊名與現名兩列都掛
    for p in seed["parties"]:
        if p.get("evidence_url"):
            out.append(
                "INSERT INTO source_refs (source_id, target_table, target_id, role, origin) "
                f"SELECT source_upsert({sql_literal(p['evidence_url'])}, 'backfill:moi_party_registry', NULL, '內政部', NULL, "
                f"'{seed['fetched_on']}T00:00:00+08:00'), 'parties', '{p['id']}', 'supporting', 'backfill:moi_party_registry' "
                "ON CONFLICT (target_table, target_id, source_id) DO NOTHING;")
    out.append("INSERT INTO party_aliases (alias_key, alias, party_id, kind, note) VALUES")
    out.append(",\n".join(
        "(" + ",".join(sql_literal(a[k]) for k in ["alias_key", "alias", "party_id", "kind", "note"]) + ")" for a in seed["aliases"]
    ) + "\nON CONFLICT (alias_key) DO NOTHING;")
    out.append("-- ↑↑↑ 資料段結束")
    return "\n".join(out) + "\n"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--fetch")
    ap.add_argument("--from", dest="src")
    ap.add_argument("--seed")
    ap.add_argument("--sql")
    ap.add_argument("--fetched-on", default=date.today().isoformat())
    args = ap.parse_args()
    if args.fetch:
        fetch_xls(args.fetch)
        if not (args.seed or args.sql):
            return 0
    src = args.src or args.fetch
    if not src:
        import tempfile
        src = tempfile.mktemp(suffix=".xls")
        fetch_xls(src)
    seed = build(read_registry(src), args.fetched_on)
    if args.seed:
        # 一列一筆（diff 看得懂、檔案不肥）；前端只在建置端讀它（lib/ssg），不進瀏覽器的 bundle
        dump = lambda v: json.dumps(v, ensure_ascii=False, separators=(",", ":"))
        lines = ["{", f' "source":{dump(seed["source"])},', f' "fetched_on":{dump(seed["fetched_on"])},', ' "parties":[']
        lines.append(",\n".join("  " + dump(p) for p in seed["parties"]))
        lines.append(" ],")
        lines.append(' "aliases":[')
        lines.append(",\n".join("  " + dump(a) for a in seed["aliases"]))
        lines.append(" ]")
        lines.append("}")
        with open(args.seed, "w", encoding="utf-8", newline="\n") as f:
            f.write("\n".join(lines) + "\n")
    if args.sql:
        with open(args.sql, "w", encoding="utf-8", newline="\n") as f:
            f.write(to_sql(seed))
    print(f"政黨 {len(seed['parties'])} 列、寫法對照 {len(seed['aliases'])} 列", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
