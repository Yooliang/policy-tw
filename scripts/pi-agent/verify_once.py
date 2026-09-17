#!/usr/bin/env python3
"""正見 最小驗證代理：領待驗證的貢獻 → 讀來源網頁 → 問 DeepSeek → 投票。

為什麼要有這支：2026-09-17 量到 924 筆待驗證合計還差 2,592 票，
其中 64% 連一票都還沒有。瓶頸不是提交，是沒有足夠的獨立驗證者。

刻意只做驗證、不做提交——提交要能上網查一手資料，那是完整代理的事；
這支只回答「這筆宣稱跟它附的來源對不對得起來」，一台 Pi 就跑得動。

⚠️ 出口 IP 決定它有沒有意義
站方依「對外 IP 的雜湊」去重（見 supabase/functions/_shared/consensus.ts）。
跟已經在跑的代理共用同一個對外 IP（同一間辦公室、同一個家用網路）等於沒有
多一個來源，票會被當重複擋掉。Pi 要走自己的出口：手機熱點、4G dongle，
或有獨立出口 IP 的 VPN。開跑前用 scripts/pi-agent/check_ip.sh 確認。

只用標準函式庫，Raspberry Pi OS 內建的 python3 就能跑。

環境變數：
  POLICY_AGENT_NAME  必填，你的代號（站上顯示用，全站唯一）
  DEEPSEEK_API_KEY   必填
  POLICY_LIMIT       一輪最多驗幾筆（預設 5，站方上限 5）
  POLICY_MODEL       預設 deepseek-v4-pro
用法：
  python3 verify_once.py            # 真的投票
  python3 verify_once.py --dry-run  # 只印出會怎麼投
"""
from __future__ import annotations

import html
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

BASE = "https://wiiqoaytpqvegtknlbue.supabase.co/functions/v1"
DEEPSEEK = "https://api.deepseek.com/chat/completions"
AGENT_TOOL = "pi-verifier/{model}"
TIMEOUT = 60
# 網頁只取前面這麼多字：判斷「宣稱與來源對不對得上」不需要整頁，
# 而 Pi 的上行頻寬與模型的輸入長度都不是免費的
PAGE_CHARS = 4000

SYSTEM = """你是台灣政見追蹤平台「正見」的查核員。你會拿到一筆別的代理提交的資料，
以及它附的來源網頁內容。你只回答一件事：這筆宣稱能不能被這份來源支持。

判準（照順序）：
1. 如果這是一筆「政見」，先問它是不是政見。競選標語、團隊組成、行程、個人表態、
   形容詞堆疊（例如「溫暖創新的新北」）都不是政見——即使來源真的這樣寫，也要 disagree。
   政見要是具體、可被追蹤的承諾。
2. 逐欄比對 payload 與來源內容。有任何一欄對不上就 disagree，並在 note 指出哪一欄、
   來源寫的是什麼。
3. 來源根本沒提到這件事、或來源內容讀不出來 → unsure，不要猜。
4. 全部對得上才 agree。

只輸出 JSON，不要任何其他文字：
{"verdict": "agree" | "disagree" | "unsure", "note": "繁體中文，一到兩句，說明依據"}
disagree 的 note 必填且要具體指出來源寫的內容。"""


def get_json(url: str) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": "policy-tw-pi-verifier/1.0"})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as res:
        return json.load(res)


def post_json(url: str, body: dict, headers: dict | None = None) -> tuple[int, dict]:
    data = json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, method="POST",
                                 headers={"Content-Type": "application/json", **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as res:
            return res.status, json.load(res)
    except urllib.error.HTTPError as e:
        # 被擋的原因（self_vote／already_voted／closed）站方寫得很清楚，要看得到
        try:
            return e.code, json.load(e)
        except Exception:
            return e.code, {"error": e.reason}


def page_text(url: str) -> str | None:
    """把來源網頁抓成純文字。抓不到就回 None——讀不到來源就不該投票。"""
    try:
        req = urllib.request.Request(url, headers={
            "User-Agent": "Mozilla/5.0 (compatible; PolicyTracker/1.0; +https://policy-tw.web.app)"})
        with urllib.request.urlopen(req, timeout=TIMEOUT) as res:
            raw = res.read(400_000)
            charset = res.headers.get_content_charset() or "utf-8"
        body = raw.decode(charset, errors="replace")
    except Exception as e:  # 逾時、403、憑證問題都算讀不到
        print(f"    來源讀不到（{type(e).__name__}）：{url}")
        return None
    body = re.sub(r"(?is)<(script|style|noscript)\b.*?</\1>", " ", body)
    text = html.unescape(re.sub(r"(?s)<[^>]+>", " ", body))
    return re.sub(r"\s+", " ", text).strip()[:PAGE_CHARS]


def ask_deepseek(item: dict, sources: list[tuple[str, str]], model: str, key: str) -> dict | None:
    lines = [f"貢獻型別：{item['contribution_type']}",
             f"提交內容：{json.dumps(item.get('payload', {}), ensure_ascii=False)}", ""]
    for url, text in sources:
        lines += [f"來源 {url} 的內容：", text, ""]
    status, body = post_json(DEEPSEEK, {
        "model": model,
        "messages": [{"role": "system", "content": SYSTEM}, {"role": "user", "content": "\n".join(lines)}],
        "temperature": 0,
        # V4 是 reasoning 模型：輸入越長它想越久，2000 在實測中會被思考吃光、content 回空
        "max_tokens": 6000,
        "response_format": {"type": "json_object"},
    }, {"Authorization": f"Bearer {key}"})
    if status != 200:
        print(f"    DeepSeek 回 {status}：{str(body)[:200]}")
        return None
    choice = (body.get("choices") or [{}])[0]
    content = choice.get("message", {}).get("content", "")
    if not content:
        print(f"    模型回空（finish_reason={choice.get('finish_reason')}）——思考用光額度，這筆跳過")
        return None
    try:
        out = json.loads(content)
    except json.JSONDecodeError:
        print(f"    模型沒回 JSON：{content[:200]}")
        return None
    if out.get("verdict") not in ("agree", "disagree", "unsure"):
        print(f"    verdict 不合法：{out}")
        return None
    return out


def main() -> int:
    dry = "--dry-run" in sys.argv
    agent = os.environ.get("POLICY_AGENT_NAME", "").strip()
    key = os.environ.get("DEEPSEEK_API_KEY", "").strip()
    model = os.environ.get("POLICY_MODEL", "deepseek-v4-pro")
    limit = max(1, min(int(os.environ.get("POLICY_LIMIT", "5")), 5))
    if not agent or not key:
        print("要先設 POLICY_AGENT_NAME 與 DEEPSEEK_API_KEY")
        return 2

    q = urllib.parse.urlencode({"agent_name": agent, "limit": limit})
    feed = get_json(f"{BASE}/verifications?{q}")
    items = feed.get("verifications", [])
    print(f"待驗證（排除自己提交與投過的）剩 {feed.get('total_pending')} 筆，這輪領 {len(items)} 筆")

    voted = skipped = 0
    for item in items:
        print(f"  [{item['contribution_type']}] {item['id'][:8]} by {item.get('agent_name')}")
        urls = [u for u in (item.get("source_urls") or []) if isinstance(u, str)][:2]
        if not urls:
            print("    沒有來源網址，跳過")
            skipped += 1
            continue
        sources = [(u, t) for u in urls if (t := page_text(u))]
        if not sources:
            # 讀不到來源就投 unsure 等於製造雜訊，寧可不投
            skipped += 1
            continue
        out = ask_deepseek(item, sources, model, key)
        if not out:
            skipped += 1
            continue
        verdict, note = out["verdict"], (out.get("note") or "").strip()
        print(f"    → {verdict}：{note[:80]}")
        if verdict == "unsure":
            skipped += 1
            continue
        if dry:
            voted += 1
            continue
        payload = {"contribution_id": item["id"], "verdict": verdict, "agent_name": agent,
                   "agent_tool": AGENT_TOOL.format(model=model), "note": note}
        if verdict == "disagree":
            payload["evidence_url"] = sources[0][0]
        status, body = post_json(f"{BASE}/verify", payload)
        if status == 201:
            voted += 1
            print(f"    已投票，目前同意 {body.get('agree_count')}／反對 {body.get('disagree_count')}")
        else:
            skipped += 1
            print(f"    投票被擋 {status}：{body.get('error') or body}")
    print(f"本輪投出 {voted} 票、略過 {skipped} 筆{'（乾跑，沒有真的投）' if dry else ''}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
