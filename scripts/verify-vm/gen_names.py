# 產生沒用過的代號。一小時一輪＝每天最多 48 個名字，不能再手工列。
# 2026-10-02 小良哥交辦：用「andy、jason 這種」常見的英文名字。
#   先前兩版備份：gen_names.py.bak-20261002（台式羅馬拼音）。
#   踩過兩次：① `名_姓首字母`（irina_d／noah_r）全長一樣 → 移除
#            ② 風格純隨機抽會讓同一輪擠在同一款 → 改成洗牌後輪流用
# 三種風格：1) 單名  2) 名.姓  3) 名+兩位數
import io, random, sys

GIVEN = """andy jason mike kevin david peter tony eric steve brian chris danny
frank gary henry ian jack james jeff john ken larry mark matt nick paul
ray rick rob roy sam scott sean simon tim tom victor wayne will alan
andrew bruce carl craig dean derek doug gordon greg harry howard hugh
jerry joe keith leon marvin neil oscar philip ralph randy ron russell
stanley terry todd troy vincent walter warren
amy anna becky carol cathy cindy debbie diana emily emma grace helen
irene jane janet jenny jessica joanna judy julie karen kate laura linda
lisa lucy mandy mary maggie michelle nancy nicole olivia pam patty rachel
rebecca ruby sally sandra sarah sharon shirley sophie stella susan tina
tracy vicky wendy betty carrie connie dana eileen fiona gloria hannah
"""
FAMILY = """smith jones brown taylor miller davis wilson moore clark lewis
walker hall allen young king wright scott green baker adams nelson carter
mitchell roberts turner phillips campbell parker evans edwards collins
stewart morris murphy cook rogers morgan peterson cooper reed bailey bell
kelly howard ward cox richardson wood watson brooks bennett gray price
myers long foster sanders ross powell sullivan jenkins perry butler
barnes fisher hughes marshall simpson webb porter hunter graham"""
GIVEN = GIVEN.split(); FAMILY = FAMILY.split()

def gen(n, used):
    r = random.Random()
    out, bag = [], []
    while len(out) < n:
        if not bag:
            bag = [0, 1, 2]; r.shuffle(bag)
        s = bag.pop()
        if s == 0:
            x = r.choice(GIVEN)
        elif s == 1:
            x = '%s.%s' % (r.choice(GIVEN), r.choice(FAMILY))
        else:
            x = '%s%02d' % (r.choice(GIVEN), r.randrange(1, 100))
        if x in used or x in out or not (2 <= len(x) <= 32):
            continue
        out.append(x)
    return out

used = set(io.open('used_names.sorted', encoding='utf-8').read().split())
names = gen(int(sys.argv[1]) if len(sys.argv) > 1 else 2, used)
with io.open('used_names.sorted', 'a', encoding='utf-8') as f:
    for x in names:
        f.write(x + '\n')
print(' '.join(names))
