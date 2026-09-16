"""
把政黨黨徽抓下來放進 public/party/，並產生 lib/party-emblems.ts 的對照表。

來源（2026-09-16 小良哥指定）：
  1. 內政部政黨資訊網 https://party.moi.gov.tw —— 官方、涵蓋 395 個備案政黨，
     但黨徽是嵌在頁面裡的 JPEG（約 4KB），不是向量圖。
  2. 維基共享資源的 SVG —— 只有幾個大黨有，畫質好、檔案小，優先用。

輸出一律 50×50（小良哥指定）：SVG 原樣複製（本來就可縮放），JPEG 轉成 50×50 PNG。
重跑這支腳本就能更新；平常不需要跑，圖檔直接進 repo。
"""
import base64
import hashlib
import io
import json
import re
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

from PIL import Image

# 內政部沒有黨徽時會回同一張「無圖」的相機佔位圖；用內容雜湊認出來丟掉，
# 不然畫面上會有一排相機。第一次跑抓到 10 個一模一樣的檔案才發現。
PLACEHOLDER_HASHES = {"f9ad4ba5d3c8e9c9c4ca9a3c1c5e7e2d"}

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "public" / "party"
SIZE = 50
UA = {"User-Agent": "policy-tw emblem fetcher (https://github.com/Yooliang/policy-tw)"}

# 大黨優先用維基的 SVG（向量、看起來比縮過的 JPEG 乾淨）
SVG_SOURCES = {
    # 內政部對這幾個政黨只回「無圖」佔位圖，但它們的人數不少（時代力量 54 人、台灣基進 24 人），
    # 所以另外從維基共享資源指名檔案（2026-09-16 用 Commons 檔案搜尋找出來的）
    "時代力量": "https://commons.wikimedia.org/wiki/Special:FilePath/New%20Power%20Party%20candidate%20icon.svg",
    "台灣基進": "https://commons.wikimedia.org/wiki/Special:FilePath/Taiwan%20Statebuilding%20Party%20Logo.png",
    "台灣團結聯盟": "https://commons.wikimedia.org/wiki/Special:FilePath/Logo%20of%20former%20Taiwan%20Solidarity%20Union.svg",
    "中國國民黨": "https://upload.wikimedia.org/wikipedia/commons/a/a1/Emblem_of_the_Kuomintang.svg",
    "民主進步黨": "https://upload.wikimedia.org/wikipedia/commons/9/9e/The_Democratic_Progressive_Party_Logo.svg",
    "台灣民眾黨": "https://upload.wikimedia.org/wikipedia/commons/0/0c/Emblem_of_Taiwan_People%27s_Party_2019.svg",
    "新黨": "https://upload.wikimedia.org/wikipedia/commons/0/01/Np_logo.svg",
    "親民黨": "https://upload.wikimedia.org/wikipedia/commons/4/4a/LogoPFP.svg",
}


def fetch(url: str, retries: int = 3) -> bytes:
    for attempt in range(retries):
        try:
            return urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60).read()
        except Exception as err:  # noqa: BLE001 - 抓什麼錯都一樣：重試，最後一次才往外丟
            if attempt == retries - 1:
                raise
            print(f"    重試（{err}）")
            time.sleep(3)
    raise RuntimeError("unreachable")


# 檔名不用黨名：中文放進檔名會因為臺／台、全形括號、以及非 ASCII 檔名很難維護
# （第一版用 [^0-9a-z] 清洗，中文全被清掉，59 個檔案互相覆蓋只剩一個）。
# 內政部的政黨編號是穩定的識別碼，維基那幾個用固定英文代號。
SVG_SLUGS = {"中國國民黨": "kmt", "民主進步黨": "dpp", "台灣民眾黨": "tpp", "新黨": "np", "親民黨": "pfp",
             "時代力量": "npp", "台灣基進": "tsp", "台灣團結聯盟": "tsu"}


def moi_emblem(party_id: str) -> bytes | None:
    """
    黨徽是 <img alt='…_黨徽' src='https://ws.moi.gov.tw/…jpg'>。
    第一版抓頁面裡的 base64 內嵌圖，結果 59 張全是「手機掃描 QR Code」那張分享用的 QR，
    拼起來看才發現——所以這裡認的是 alt 帶「黨徽」的那個 img。
    """
    html = fetch(f"https://party.moi.gov.tw/PartyMainContent.aspx?n=16100&sms=13073&s={party_id}").decode("utf-8", "replace")
    m = re.search(r"<img[^>]*alt=['\"][^'\"]*黨徽['\"][^>]*src=['\"]([^'\"]+)['\"]", html)
    if not m:
        m = re.search(r"<img[^>]*src=['\"](https://ws\.moi\.gov\.tw/[^'\"]+)['\"][^>]*alt=['\"][^'\"]*黨徽", html)
    if not m:
        return None
    return fetch(urllib.parse.urljoin("https://party.moi.gov.tw/", m.group(1)))


def wikipedia_emblem(name: str) -> bytes | None:
    """
    內政部沒有的就問中文維基。只接受檔名看得出是標誌的
    （台灣基進那一頁的 pageimage 是一張研究機構的圖，不加這道會抓錯）。
    """
    api = "https://zh.wikipedia.org/w/api.php?" + urllib.parse.urlencode(
        {"action": "query", "prop": "pageimages", "piprop": "original", "titles": name, "format": "json", "formatversion": "2"}
    )
    try:
        page = json.loads(fetch(api).decode("utf-8"))["query"]["pages"][0]
        src = page.get("original", {}).get("source")
    except Exception:  # noqa: BLE001 - 查不到就當沒有
        return None
    if not src:
        return None
    filename = urllib.parse.unquote(src.rsplit("/", 1)[-1]).lower()
    if not any(word in filename for word in ("logo", "emblem", "黨徽", "党徽", "標誌", "标志", "badge", "seal")):
        print(f"    維基的圖看不出是標誌（{filename[:40]}），不採用")
        return None
    print("    改用維基的圖")
    return fetch(src.split("?")[0])


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    matched: dict[str, str] = json.loads((ROOT / "scripts" / "party-ids.json").read_text("utf-8"))
    emblems: dict[str, str] = {}

    for name, url in SVG_SOURCES.items():
        ext = "svg" if url.lower().endswith(".svg") else "png"
        path = OUT / f"{SVG_SLUGS[name]}.{ext}"
        print(f"[維基 {ext.upper()}] {name}")
        raw = fetch(url)
        if ext == "svg":
            path.write_bytes(raw)
        else:
            img = Image.open(io.BytesIO(raw)).convert("RGBA")
            img.thumbnail((SIZE, SIZE), Image.LANCZOS)
            canvas = Image.new("RGBA", (SIZE, SIZE), (255, 255, 255, 0))
            canvas.paste(img, ((SIZE - img.width) // 2, (SIZE - img.height) // 2), img)
            canvas.save(path, "PNG", optimize=True)
        emblems[name] = f"/party/{path.name}"

    # 先全部抓下來再決定要留誰：佔位圖要靠「同一張圖出現在多個政黨」認出來，
    # 邊抓邊判斷的話第一個拿到佔位圖的政黨會被留下（第一版就是這樣留了一張相機圖）。
    downloaded: list[tuple[str, str, bytes]] = []
    for name, party_id in sorted(matched.items()):
        if name in emblems:
            continue
        print(f"[內政部] {name}（s={party_id}）")
        raw = moi_emblem(party_id)
        time.sleep(0.5)  # 對方是政府網站，慢慢來
        if not raw:
            raw = wikipedia_emblem(name)
        if not raw:
            print("    沒有黨徽，跳過")
            continue
        downloaded.append((name, party_id, raw))

    counts: dict[str, int] = {}
    for _, _, raw in downloaded:
        digest = hashlib.md5(raw).hexdigest()
        counts[digest] = counts.get(digest, 0) + 1

    for name, party_id, raw in downloaded:
        digest = hashlib.md5(raw).hexdigest()
        if counts[digest] > 1 or digest in PLACEHOLDER_HASHES:
            print(f"    {name}：同一張圖出現在 {counts[digest]} 個政黨，是佔位圖，跳過")
            continue
        # 維基補位時可能拿到 SVG（PIL 打不開，整支腳本會掛）；SVG 原樣存，本來就可縮放
        head = raw[:200].lstrip()
        if head.startswith(b"<svg") or head.startswith(b"<?xml"):
            path = OUT / f"moi-{party_id}.svg"
            path.write_bytes(raw)
            emblems[name] = f"/party/{path.name}"
            continue
        try:
            img = Image.open(io.BytesIO(raw)).convert("RGB")
        except Exception as err:  # noqa: BLE001 - 認不出來的就當沒有，不要讓一張壞圖擋住整批
            print(f"    {name}：圖檔認不出來（{err}），跳過")
            continue
        img.thumbnail((SIZE, SIZE), Image.LANCZOS)
        canvas = Image.new("RGB", (SIZE, SIZE), "white")
        canvas.paste(img, ((SIZE - img.width) // 2, (SIZE - img.height) // 2))
        path = OUT / f"moi-{party_id}.png"
        canvas.save(path, "PNG", optimize=True)
        emblems[name] = f"/party/{path.name}"

    total = sum(f.stat().st_size for f in OUT.iterdir())
    print(f"\n共 {len(emblems)} 個黨徽，{total / 1024:.0f} KB")
    # 產出 TS 對照表讓前端 import 進 bundle（不用另外 fetch 一個 JSON）
    lines = [
        "// 這個檔案由 scripts/fetch-party-emblems.py 產生，不要手改。",
        "// 圖檔來源：內政部政黨資訊網（官方）與維基共享資源；黨徽是各政黨的標誌，在這裡作識別用途。",
        "",
        "export const PARTY_EMBLEMS: Readonly<Record<string, string>> = {",
        *[f'  "{name}": "{path}",' for name, path in sorted(emblems.items())],
        "}",
        "",
    ]
    (ROOT / "lib" / "party-emblems.ts").write_text("\n".join(lines), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
