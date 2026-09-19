"""
「小模型不動腦」的驗證代理原型：小模型只做搜尋、抓文本、上傳；判定交給 Jev。
這裡連小模型都沒有——證明這條軌道的膠水部分不需要推理。真的小模型只多做一件事：決定搜尋關鍵字。

流程（對應 skill.md §2-9，2026-09-19 版）：
  GET /next → 拿到 verify 項與 current.system_vote
  system_vote 是 supported → 不重看提交的那一頁，去找第二個獨立來源（DuckDuckGo lite，免金鑰）
  把第二來源的網址交給正見的 judge 端點（伺服器自己抓頁、Jev 每欄一題）→ agree／disagree／unsure
  DRY_RUN=1 時只印出會投什麼，不 POST；否則 POST /report kind=verify，帶 evidence_url（第二來源）
  kind=task 且是 election_result_missing／candidate_status_stale → 自己搜第一來源，POST system-one?action=extract 讓 Jev 選值，
  counts 為 true 就把回應裡的 suggested_contribution 原樣 POST /contribute（值是有限域的任務才行）

用法：
  SUPABASE_URL=… SUPABASE_ANON_KEY=… AGENT_NAME=<你的代號或 ditrust:<序號>> ROUNDS=10 DRY_RUN=1 python relay_jev_verify.py
  不需要任何 Jev／OpenRouter 金鑰：判定走正見的 system-one?action=judge（使用者 2026-09-19：「jev 提供端點，別給 key」）

紅線（docs/BLUEPRINT-jev-decisions.md §3-1）：不能拿 Jev 對「提交的那一頁」的判定當代理票——那等於系統票再投一次。
這支只用 Jev 核「另一個來源」，票的獨立性來自新的網址（evidence_url），不是來自判斷者。
2026-09-19 乾跑 4 筆連江縣參選紀錄：3 筆找到第二來源且六欄全 confirmed、1 筆 unsure；每頁 Jev 成本約 $0.0002。
"""
import json, os, re, sys, html, urllib.request, urllib.parse, time

URL = os.environ["SUPABASE_URL"].rstrip("/")
ANON = os.environ["SUPABASE_ANON_KEY"]
AGENT = os.environ.get("AGENT_NAME", "jev-relay-test")
DRY = os.environ.get("DRY_RUN", "1") == "1"
ROUNDS = int(os.environ.get("ROUNDS", "5"))
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128 Safari/537.36"

def http(method, url, body=None, headers=None, timeout=30):
    h = {"User-Agent": UA, "Accept-Language": "zh-TW,zh;q=0.9"}
    if headers: h.update(headers)
    data = json.dumps(body).encode() if body is not None else None
    if data is not None: h["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=h, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, r.read()

def api(method, path, body=None):
    st, raw = http(method, f"{URL}/functions/v1/{path}", body, {"Authorization": f"Bearer {ANON}", "apikey": ANON})
    return st, json.loads(raw)

# ---- 文本抽取（跟 system-one 同一套精神：JSON-LD articleBody 優先）----
def html_to_text(h):
    body = []
    for m in re.finditer(r'<script[^>]+application/ld\+json[^>]*>(.*?)</script>', h, re.S | re.I):
        try:
            d = json.loads(m.group(1))
        except Exception:
            continue
        for it in (d if isinstance(d, list) else [d]):
            if isinstance(it, dict):
                for k in ("headline", "articleBody", "description"):
                    if isinstance(it.get(k), str) and it[k].strip(): body.append(it[k].strip())
    s = re.sub(r"(?is)<(script|style|noscript|svg|header|footer|nav).*?</\1>", " ", h)
    s = re.sub(r"(?s)<[^>]+>", " ", s); s = html.unescape(s)
    s = re.sub(r"[ \t\r\f\v]+", " ", s); s = re.sub(r"\n\s*\n+", "\n", s).strip()
    return ("\n".join(body) + "\n\n" + s) if body else s

def fetch_text(url):
    try:
        st, raw = http("GET", url, timeout=25)
    except Exception as e:
        return None, f"error:{type(e).__name__}"
    if url.lower().endswith(".pdf") or raw[:5] == b"%PDF-":
        return None, "pdf（原型不抽字）"
    enc = "utf-8"
    m = re.search(rb'charset=["\']?([\w-]+)', raw[:4000])
    if m: enc = m.group(1).decode()
    try: s = raw.decode(enc, errors="ignore")
    except Exception: s = raw.decode("utf-8", errors="ignore")
    return html_to_text(s), "html"

def focus(text, names, limit=6000):
    starts = set()
    for n in names:
        if not n or len(n) < 2: continue
        for m in re.finditer(re.escape(n), text):
            starts.add(max(0, m.start() - 700))
            if len(starts) >= 6: break
    if not starts: return text[:limit]
    out, used = [], 0
    for st in sorted(starts):
        c = text[st:st + 1400]; out.append(c); used += len(c)
        if used >= limit: break
    return "\n…\n".join(out)[:limit]

# ---- 搜尋第二來源（免金鑰）：真的小模型在這裡只需要決定關鍵字 ----
def search(query, exclude_hosts, k=4):
    q = urllib.parse.quote(query)
    st, raw = http("GET", f"https://lite.duckduckgo.com/lite/?q={q}", timeout=25)
    links = re.findall(r'uddg=([^&"]+)', raw.decode("utf-8", errors="ignore"))
    out = []
    for l in links:
        u = urllib.parse.unquote(l)
        host = urllib.parse.urlparse(u).hostname or ""
        if any(host.endswith(x) for x in exclude_hosts): continue
        if host.endswith("duckduckgo.com") or host.endswith("wikipedia.org") and False: continue
        if u not in out: out.append(u)
        if len(out) >= k: break
    return out

def keywords(ctype, payload):
    name = payload.get("name") or payload.get("politician_name") or ""
    if ctype == "candidacy":
        return f'{name} {payload.get("region","")} {payload.get("election_type","")} 登記 參選'
    if ctype == "policy":
        return f'{name} {payload.get("title","")}'
    if ctype == "politician":
        return f'{name} {payload.get("region","")} {payload.get("current_position","")}'
    return f'{name} {payload.get("title","")}'

# ---- 第二來源判定：交給正見的端點，網頁由伺服器抓（代理只給網址）----
def judge(cid, url):
    st, out = api("POST", "system-one?action=judge", {"contribution_id": cid, "url": url})
    return out

# ---- 主迴圈 ----
# ---- 任務：自己找第一來源，讓 Jev 選值（extract）----
# 使用者 2026-09-19：「它應該是收到任務之後，分析關鍵字自己找來源，不一定要去看既有的那個」。
# 只有值在有限域裡的任務能這樣做（選舉結果、登記狀態）；政見這種自由文字還是要會抽字的模型。
EXTRACT_TYPES = ("election_result_missing", "candidate_status_stale")

def api_soft(method, path, body=None):
    """4xx 也回 (status, json)，不丟例外"""
    try:
        return api(method, path, body)
    except urllib.error.HTTPError as e:
        try: return e.code, json.loads(e.read())
        except Exception: return e.code, {"error": f"http {e.code}"}

def task_keywords(task_type, t):
    name, region, et, yr = t.get("name", ""), t.get("region", ""), t.get("election_type", ""), t.get("election_id", "")
    if task_type == "election_result_missing":
        return f"{name} {region} {yr} {et} 選舉 當選"
    return f"{name} {region} {et} 候選人 登記 名單"

def handle_task(i, item):
    tt, tid, t = item["task_type"], item["task_id"], item.get("target") or {}
    print(f"\n[{i}] task {tt} {tid} | {t.get('name')} {t.get('region')} {t.get('election_id')} {t.get('election_type')}")
    q = task_keywords(tt, t)
    try:
        cands = search(q, [])
    except Exception as e:
        cands = []; print(f"   搜尋失敗 {type(e).__name__}")
    print(f"   搜尋「{q}」→ {len(cands)} 個候選")
    for u in cands[:4]:
        st, out = api_soft("POST", "system-one?action=extract", {"task_id": tid, "url": u})
        if not out.get("success"):
            print(f"   - {u[:70]} → {out.get('error')}：{str(out.get('message', ''))[:60]}"); continue
        sp = out["same_person"]
        print(f"   - {u[:70]}\n     extract → {out['field']}={out['value']} {out['probability']:.2f} 同一人={sp['choice']}({sp['probability']:.2f}) counts={out['counts']}")
        if not out["counts"]:
            print("     " + str(out.get("hint", ""))); continue
        c = out["suggested_contribution"]
        c.update({"agent_name": AGENT, "agent_tool": "relay/jev-1.13",
                  "note": f"第一來源（{urllib.parse.urlparse(u).hostname}）由 Jev 判定 {out['field']}={out['value']}（{out['probability']}）；同一人 {sp['probability']}"})
        print(f"   ⇒ 會交 {c['contribution_type']} {json.dumps(c['payload'], ensure_ascii=False)[:110]}")
        if not DRY:
            st, res = api_soft("POST", "contribute", c)
            print(f"   POST /contribute → {st} {json.dumps(res, ensure_ascii=False)[:160]}")
        return True
    print("   ⇒ 沒找到能定值的來源，釋放任務")
    if not DRY: api_soft("GET", f"next?agent_name={AGENT}&skip={tid}")
    return False

def main():
    # 測試用：TASK_ID＋TARGET_JSON 直接跑一個任務，不經 /next
    if os.environ.get("TASK_ID"):
        tid = os.environ["TASK_ID"]
        handle_task(1, {"task_type": tid.split(":")[1], "task_id": tid, "target": json.loads(os.environ.get("TARGET_JSON", "{}"))})
        return
    seen = set()
    for i in range(ROUNDS):
        st, nxt = api("GET", f"next?agent_name={AGENT}&agent_tool=relay/jev-1.13")
        if nxt.get("kind") == "task" and (nxt.get("item") or {}).get("task_type") in EXTRACT_TYPES:
            handle_task(i + 1, nxt["item"]); time.sleep(1); continue
        if nxt.get("kind") != "verify":
            tid = (nxt.get("item") or {}).get("task_id")
            print(f"[{i+1}] kind={nxt.get('kind')}，不是驗證，{'跳過並釋放' if tid else '略過'}")
            if tid: api("GET", f"next?agent_name={AGENT}&skip={tid}")
            continue
        it = nxt["item"]; cid = it["contribution_id"]
        if cid in seen: print(f"[{i+1}] 重複拿到 {cid[:8]}，略過"); continue
        seen.add(cid)
        ctype, payload = it["contribution_type"], it["payload"]
        sv = (it.get("current") or {}).get("system_vote") or {}
        print(f"\n[{i+1}] {ctype} {cid[:8]} {payload.get('name') or payload.get('title','')[:20]} | 需 {it.get('votes_needed') or nxt.get('votes_needed') or '?'} 票 | 系統票={sv.get('verdict','（無）')} {sv.get('probability','')}")
        exclude = [urllib.parse.urlparse(u).hostname or "" for u in it.get("source_urls", [])]
        exclude = [h[4:] if h.startswith("www.") else h for h in exclude]
        q = keywords(ctype, payload)
        try:
            cands = search(q, exclude)
        except Exception as e:
            cands = []; print(f"   搜尋失敗 {type(e).__name__}")
        print(f"   搜尋「{q.strip()}」→ {len(cands)} 個候選（排除提交來源 {exclude}）")
        vote, evidence, note = "unsure", None, ""
        for u in cands[:3]:
            try:
                out = judge(cid, u)
            except Exception as e:
                print(f"   - {u[:70]} → judge 失敗 {type(e).__name__}"); continue
            if not out.get("success"):
                print(f"   - {u[:70]} → {out.get('error')}：{str(out.get('message',''))[:60]}"); continue
            fields = {k: (f["verdict"], f["p"]) for k, f in (out.get("fields") or {}).items()}
            fs = " ".join(f"{k}={vv[:4]}({pp:.2f})" for k, (vv, pp) in fields.items())
            v, p = out["verdict"], out["probability"]
            print(f"   - {u[:70]}\n     judge → {v} {p:.2f} counts={out.get('counts')} | {fs}")
            if not out.get("counts"):
                print("     不到門檻，換下一個候選"); continue
            if v == "supported":
                vote, evidence = "agree", u
                note = f"第二來源（{urllib.parse.urlparse(u).hostname}）證實：" + "、".join(k for k, (vv, _) in fields.items() if vv == "confirmed")
                break
            if v == "not_supported":
                vote, evidence = "disagree", u
                note = f"第二來源（{urllib.parse.urlparse(u).hostname}）反證：" + "、".join(k for k, (vv, _) in fields.items() if vv == "contradicted")
                break
        if vote == "unsure":
            note = "找不到能證實關鍵欄位的第二來源；搜尋了 " + ", ".join(urllib.parse.urlparse(u).hostname or u for u in cands[:3])
        print(f"   ⇒ 會投 {vote}" + (f"，evidence_url={evidence}" if evidence else "") + f"｜note：{note[:80]}")
        if not DRY:
            body = {"kind": "verify", "contribution_id": cid, "verdict": vote, "agent_name": AGENT, "agent_tool": "relay/jev-1.13", "note": note}
            if evidence: body["evidence_url"] = evidence
            st, out = api("POST", "report", body)
            print(f"   POST /report → {st} {json.dumps(out, ensure_ascii=False)[:120]}")
        time.sleep(1)

if __name__ == "__main__":
    main()
