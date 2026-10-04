# 本機登入帳號的即時週額度。輸出 LOCAL|<已用%>|<resets_at ISO UTC>
# 🔴 不要在這裡寫死帳號名：本機登入會換（10-01 13:xx 是 gs it、14:xx 就換成 cwen 了），
#    寫死會把一個帳號的數字貼到另一個頭上（實際發生過，兩行都變成同一個帳號）。
#    帳號由 plan_round.py 用 resets_at 比對 Aegis 的列來認（兩帳號重置時間不同天）。
# 本機 credentials 裡的 accessToken 可以打 usage 端點（metadata 裡那種 sk-ant-oat 不行，會 403）。
import json, pathlib, urllib.request
tok = json.loads(pathlib.Path.home().joinpath('.claude/.credentials.json').read_text())['claudeAiOauth']['accessToken']
req = urllib.request.Request('https://api.anthropic.com/api/oauth/usage',
                             headers={'Authorization': 'Bearer ' + tok, 'anthropic-beta': 'oauth-2025-04-20'})
w = json.loads(urllib.request.urlopen(req, timeout=30).read())['seven_day']
print('LOCAL|%s|%s' % (w['utilization'], str(w['resets_at'])[:16]))
