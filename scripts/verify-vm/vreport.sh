#!/bin/bash
# 驗證 VM 進度＋額度一次讀（不印序號）
cd "$(dirname "$0")"
# Python：工作機是 C:/Python312，家用機用 py 啟動器找 3.12；可用 PY 環境變數覆寫
PY=${PY:-$( [ -x C:/Python312/python.exe ] && echo C:/Python312/python.exe || py -3.12 -c "import sys;print(sys.executable,end='')")}
bash tick.sh >/dev/null 2>&1
grep -oE "^(cwen|gsit|acct3) +(已用 +[0-9.]+%|額度未知|未啟用)" decision.txt | tr -s ' '
echo "VM $(gcloud compute instances describe policy-verifier --zone us-central1-a --format='value(status)')"
# 序號：先讀 Secret Manager（verify-vm-<鍵>，專案看 VM metadata secret-project，預設 policy-tw），讀不到退回 metadata；只進變數不印出
SECRET_PROJECT=$(gcloud compute instances describe policy-verifier --zone us-central1-a --format='value(metadata.items.secret-project)' 2>/dev/null | tr -d '\r\n')
[ -n "$SECRET_PROJECT" ] || SECRET_PROJECT=policy-tw
serial() { local v; v=$(gcloud secrets versions access latest --secret "verify-vm-$1" --project "$SECRET_PROJECT" 2>/dev/null | tr -d '\r\n'); [ -n "$v" ] || v=$(gcloud compute instances describe policy-verifier --zone us-central1-a --format="value(metadata.items.$1)" 2>/dev/null | tr -d '\r\n'); printf '%s' "$v"; }
S1=$(serial ditrust-serial) S2=$(serial ditrust-serial-2) S3=$(serial ditrust-serial-3) PYTHONIOENCODING=utf-8 "$PY" - <<'PY'
import json,os,re,urllib.request,urllib.parse,pathlib
env=dict(re.findall(r'^([A-Za-z_]+)=(.*)$',open("../../.env",encoding="utf-8-sig").read(),re.M))
U=env["VITE_SUPABASE_URL"].strip(); K=env["VITE_SUPABASE_ANON_KEY"].strip(); H={"apikey":K,"authorization":"Bearer "+K}
for lab,k in (("帳號一","S1"),("帳號二","S2"),("帳號三","S3")):
    if not os.environ.get(k,"").strip(): continue   # 沒設的帳號略過（序號只讀進環境變數，不印）
    q=json.loads(urllib.request.urlopen(urllib.request.Request(U+"/functions/v1/next?agent_tool=claude-code/claude-sonnet-5&agent_name="+urllib.parse.quote("ditrust:"+os.environ[k].strip()),headers=H),timeout=140).read()).get("quota") or {}
    print(lab,q["submit"]["used"],q["verify"]["used"])
b=json.load(urllib.request.urlopen(urllib.request.Request(U+"/functions/v1/contributions-feed?status=all&limit=1",headers=H),timeout=90))["summary"]["by_status"]
print("待驗證",b.get("pending"),"上線",b.get("applied"),"退件",b.get("rejected"))
tok=json.loads(pathlib.Path.home().joinpath('.claude/.credentials.json').read_text())['claudeAiOauth']['accessToken']
w=json.loads(urllib.request.urlopen(urllib.request.Request('https://api.anthropic.com/api/oauth/usage',headers={'Authorization':'Bearer '+tok,'anthropic-beta':'oauth-2025-04-20'}),timeout=30).read())
print("本機 five_hour",w['five_hour']['utilization'],"seven_day",w['seven_day']['utilization'])
PY
date
