#!/usr/bin/env python3
"""正見協議代理：把 skill.md 交給模型，讓它自己跑一輪。

站上教人怎麼用的那句話就是這支在做的事：
    「請先讀 https://policy-tw.web.app/skill.md，照裡面的規則幫『正見』查證並提交資料貢獻。」

所以這支**不替模型決定任何事**。它只提供三件模型自己做不到的事：
  1. http_get     —— 抓網頁（協議要求去查官方來源）
  2. call_api     —— 打協議端點（白名單擋住其他網址）
  3. finish       —— 收工，附一行回報

派工優先序、驗證與任務的比例、跳過記憶、額度規則，全部在伺服器與協議手上，
這支一行都不實作。前一版（scripts/pi-agent/verify_once.py）反過來：模型只回
一個 verdict，其餘我用 Python 寫死，結果自己重寫了一套比伺服器差的派工邏輯，
還得補一個本地「已判清單」去修它造成的重複——那個坑就是這樣來的。

護欄（是護欄，不是代替它判斷）：
  - call_api 只認協議端點，其他網址一律拒絕
  - agent_name／agent_tool 由這支蓋掉，模型不能冒用別人的代號
  - 每輪工具呼叫有上限，抓回來的網頁會截斷
  - --dry-run 時所有 POST 只印不送
  - 每一次呼叫都印出來，journalctl 看得到它做了什麼

環境變數：POLICY_AGENT_NAME、DEEPSEEK_API_KEY、POLICY_MODEL、POLICY_MAX_STEPS
"""
from __future__ import annotations

import html
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

SKILL_URL = "https://policy-tw.web.app/skill.md"
API_BASE = "https://wiiqoaytpqvegtknlbue.supabase.co/functions/v1"
DEEPSEEK = "https://api.deepseek.com/chat/completions"
# 協議裡代理會用到的端點；不在這份名單裡的一律拒絕
ALLOWED = {"next", "report", "verify", "contribute", "tasks", "verifications",
           "contribution-status", "history", "ask", "request-task"}
PAGE_CHARS = 6000
TIMEOUT = 60

TOOLS = [
    {"type": "function", "function": {
        "name": "http_get", "description": "抓一個網址，回傳純文字（已去掉 HTML 標籤，過長會截斷）。查證來源用。",
        "parameters": {"type": "object", "properties": {"url": {"type": "string"}}, "required": ["url"]}}},
    {"type": "function", "function": {
        "name": "call_api",
        "description": "呼叫正見協議端點。path 只寫端點名（例如 next、report、verify）；GET 用 query，POST 用 body。",
        "parameters": {"type": "object", "properties": {
            "method": {"type": "string", "enum": ["GET", "POST"]},
            "path": {"type": "string"},
            "query": {"type": "object"},
            "body": {"type": "object"},
        }, "required": ["method", "path"]}}},
    {"type": "function", "function": {
        "name": "finish", "description": "這一輪結束，附一行回報（協議 5b.5 要求）。",
        "parameters": {"type": "object", "properties": {"summary": {"type": "string"}}, "required": ["summary"]}}},
]


def fetch_text(url: str, limit: int = PAGE_CHARS) -> str:
    req = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0 (compatible; PolicyTracker/1.0; +https://policy-tw.web.app)"})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as res:
        raw = res.read(400_000)
        charset = res.headers.get_content_charset() or "utf-8"
    body = raw.decode(charset, errors="replace")
    body = re.sub(r"(?is)<(script|style|noscript)\b.*?</\1>", " ", body)
    text = html.unescape(re.sub(r"(?s)<[^>]+>", " ", body))
    return re.sub(r"[ \t]+", " ", text).strip()[:limit]


def http_json(method: str, url: str, body: dict | None = None, headers: dict | None = None) -> tuple[int, object]:
    data = json.dumps(body).encode() if body is not None else None
    head = dict(headers or {})
    if data:
        head["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, method=method, headers=head)
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as res:
            return res.status, json.load(res)
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.load(e)
        except Exception:
            return e.code, {"error": e.reason}


def run_tool(name: str, args: dict, agent: str, tool_label: str, dry: bool) -> str:
    """回給模型的字串。失敗也要回字串——讓它自己看到錯誤並決定怎麼辦。"""
    if name == "http_get":
        url = str(args.get("url", ""))
        if not url.startswith(("http://", "https://")):
            return "拒絕：url 要是 http(s) 網址"
        print(f"    http_get {url}")
        try:
            return fetch_text(url)
        except Exception as e:
            return f"抓不到（{type(e).__name__}）：{e}"

    if name == "call_api":
        path = str(args.get("path", "")).strip("/").split("?")[0]
        if path not in ALLOWED:
            return f"拒絕：{path} 不在允許的端點內。可用：{'、'.join(sorted(ALLOWED))}"
        method = str(args.get("method", "GET")).upper()
        query = dict(args.get("query") or {})
        body = dict(args.get("body") or {})
        # 代號由執行環境決定，不讓模型冒用別人的
        if method == "GET":
            query.setdefault("agent_name", agent)
            if path in ("next", "request-task"):
                query["agent_name"], query["agent_tool"] = agent, tool_label
        else:
            body["agent_name"], body["agent_tool"] = agent, tool_label
        url = f"{API_BASE}/{path}" + (f"?{urllib.parse.urlencode(query)}" if query else "")
        if method == "POST" and dry:
            print(f"    [乾跑] POST {path} {json.dumps(body, ensure_ascii=False)[:300]}")
            return "乾跑模式：沒有真的送出。當作成功，繼續這一輪。"
        print(f"    {method} {path} {json.dumps(body, ensure_ascii=False)[:200] if body else ''}")
        status, out = http_json(method, url, body if method == "POST" else None)
        print(f"      → {status}")
        return json.dumps({"status": status, "response": out}, ensure_ascii=False)[:8000]

    return f"沒有這個工具：{name}"


def main() -> int:
    dry = "--dry-run" in sys.argv
    agent = os.environ.get("POLICY_AGENT_NAME", "").strip()
    key = os.environ.get("DEEPSEEK_API_KEY", "").strip()
    model = os.environ.get("POLICY_MODEL", "deepseek-v4-pro")
    max_steps = int(os.environ.get("POLICY_MAX_STEPS", "24"))
    if not agent or not key:
        print("要先設 POLICY_AGENT_NAME 與 DEEPSEEK_API_KEY")
        return 2
    tool_label = f"policy-agent/{model}"

    # 協議第一條：每輪開始重讀一次本協議，以最新內容為準
    print(f"讀取協議 {SKILL_URL}")
    skill = fetch_text(SKILL_URL, limit=120_000)
    print(f"  {len(skill)} 字")

    messages = [
        {"role": "system", "content":
            f"你是「正見」的外部 AI 代理，代號 {agent}，工具標示 {tool_label}。\n"
            "以下是完整協議，照它做事。你自己決定這一輪要驗證什麼、要查什麼、要不要提交；\n"
            "呼叫端點用 call_api（只寫端點名），查來源用 http_get，做完用 finish 回報一行。\n"
            "agent_name／agent_tool 由執行環境自動填，不要自己編。\n"
            "查不到就不要提交，寧可少做也不要送出沒有把握的資料。\n"
            "提醒：Google／Bing／DuckDuckGo 這類搜尋引擎會擋程式抓取，抓回來多半是空的。\n"
            "直接去官方網站（中選會、縣市政府、議會）與新聞網站，不要把呼叫次數花在搜尋頁上。\n\n"
            f"=== 協議全文 ===\n{skill}"},
        {"role": "user", "content":
            "請先讀上面的協議，照裡面的規則幫「正見」查證並提交資料貢獻。開始這一輪。"},
    ]

    started = time.time()
    calls = 0
    for step in range(1, max_steps + 1):
        status, body = http_json("POST", DEEPSEEK, {
            "model": model, "messages": messages, "tools": TOOLS,
            "max_tokens": 8000, "temperature": 0,
        }, {"Authorization": f"Bearer {key}"})
        if status != 200:
            print(f"DeepSeek 回 {status}：{str(body)[:300]}")
            return 1
        choice = (body.get("choices") or [{}])[0]  # type: ignore[union-attr]
        msg = choice.get("message", {})
        # 思考內容不回傳給模型（介面不吃），但回覆與工具呼叫要留在對話裡
        messages.append({"role": "assistant", "content": msg.get("content") or "",
                         **({"tool_calls": msg["tool_calls"]} if msg.get("tool_calls") else {})})
        if msg.get("content"):
            print(f"  [{step}] {msg['content'].strip()[:300]}")
        tool_calls = msg.get("tool_calls") or []
        if not tool_calls:
            # 沒叫工具也沒收工：再推一次，兩次都這樣就結束，不要空轉燒額度
            if choice.get("finish_reason") == "stop" and step > 1:
                print("模型沒有再動作，這一輪結束")
                break
            messages.append({"role": "user", "content": "繼續：呼叫工具，或用 finish 收工。"})
            continue
        for call in tool_calls:
            fn = call.get("function", {})
            name = fn.get("name", "")
            try:
                args = json.loads(fn.get("arguments") or "{}")
            except json.JSONDecodeError:
                args = {}
            if name == "finish":
                print(f"本輪回報：{args.get('summary', '')}")
                print(f"（{calls} 次工具呼叫、{int(time.time() - started)} 秒{'，乾跑' if dry else ''}）")
                return 0
            calls += 1
            result = run_tool(name, args, agent, tool_label, dry)
            messages.append({"role": "tool", "tool_call_id": call.get("id"), "content": result})
    print(f"到達本輪上限（{max_steps} 步、{calls} 次工具呼叫、{int(time.time() - started)} 秒）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
