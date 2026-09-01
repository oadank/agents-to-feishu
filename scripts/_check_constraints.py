# -*- coding: utf-8 -*-
"""复刻 reasonix ParseConstraints 的禁变更检测，定位 persona 里的触发子句"""
import io, re

env = io.open(r'C:\Users\oadan\.agents-to-feishu\config.reasonix.env', encoding='utf-8').read()

def grab(key):
    m = re.search(key + '="((?:[^"\\\\]|\\\\.)*)"', env)
    if not m:
        return ''
    return m.group(1).replace('\\n', '\n').replace('\\"', '"')

persona = grab('CTI_SYSTEM_PROMPT_GLOBAL') + '\n\n' + grab('CTI_BOT_REASONIX_SYSTEM_PROMPT')
print('persona len =', len(persona))

# Go: strings.FieldsFunc 以 \n \r . ! ? ; 。！？； 分句
clauses = re.split(r'[\n\r.!?;。！？；]', persona)
hits = 0
for cl in clauses:
    t = cl.strip().lstrip('-*•0123456789. )\t')
    if not t:
        continue
    # hasExplicitReadOnlyClause
    if t == '只读' or t.startswith('只读') or t.startswith('只读 '):
        print('[PREFIX-只读]', t[:90]); hits += 1
    if t == 'read-only' or t.startswith('read-only ') or t == 'read only' or t.startswith('read only '):
        print('[PREFIX-read-only]', t[:90]); hits += 1
    for ph in ['只分析', '仅分析', '只看不改', '复现但不修复', '只复现', '仅复现',
               'analysis only', 'read-only review']:
        if ph in cl:
            print('[PHRASE]', ph, '|', t[:90]); hits += 1
    # hasGlobalNegatedMutationClause 前缀类
    if t.startswith(('不要修改', '不要改动', '不要改', '别修改', '别改', '勿修改')):
        print('[PREFIX-不要改]', t[:90]); hits += 1

print('total hits =', hits)
