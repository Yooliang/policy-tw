# 在 Aegis 上跑：輸出純 ASCII 的額度資料，避免中文經 SSH 管線後編碼跑掉。
# 每行 = ACCT|<帳號>|<本週已用%>|<resets_at ISO UTC>
import json, datetime
env = {}
for line in open('/home/cwen0708/onestack/aegis/.env'):
    line = line.strip()
    if '=' in line and not line.startswith('#'):
        k, v = line.split('=', 1)
        env[k.strip()] = v.strip().strip('"').strip("'")
url = env['DATABASE_URL'].replace('postgresql+psycopg2', 'postgresql').replace('+asyncpg', '')
import psycopg2
c = psycopg2.connect(url); cur = c.cursor()
cur.execute("SELECT name, quota_json FROM aegis_account WHERE provider='claude' AND quota_json IS NOT NULL AND quota_json <> '' ORDER BY id")
for name, q in cur.fetchall():
    try:
        d = json.loads(q) if isinstance(q, str) else q
    except Exception:
        continue
    slug = 'gsit' if 'it' in (name or '').lower() and 'gs' in (name or '').lower() else 'cwen'
    for lim in d.get('limits', []):
        lb = str(lim.get('label', ''))
        # 週上限那一條：label 含「週」或 week
        if '週' in lb or 'week' in lb.lower():
            print('ACCT|%s|%s|%s' % (slug, lim.get('percent'), str(lim.get('resets_at'))[:16]))
