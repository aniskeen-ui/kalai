#!/usr/bin/env python3
"""Load the researched couriers (public/data/courier-estimates.json) into one site's supplier list (AWS CloudShell).

  curl -s https://main.dr27naflhxnim.amplifyapp.com/data/courier-estimates.json -o ce.json
  python3 load-courier-estimates.py ce.json test        # or: prod

Same as the admin button "Add / refresh the researched couriers": new couriers become prospects (to ask for quotes);
a prospect that hasn't entered its own prices gets the new estimate; the approved courier with the same name
(Aramex → ARAMAX) gets only its EMPTY cells filled, its own prices stay.
"""
import json, sys, uuid, datetime, boto3

src, stage = sys.argv[1], (sys.argv[2] if len(sys.argv) > 2 else 'test')
lam, ddb = boto3.client('lambda'), boto3.client('dynamodb')
table = None
for page in lam.get_paginator('list_functions').paginate():
    for f in page['Functions']:
        if 'zohoquotesync' in f['FunctionName'].replace('-', '').lower():
            env = lam.get_function_configuration(FunctionName=f['FunctionName']).get('Environment', {}).get('Variables', {})
            if env.get('KALAI_STAGE', 'test') == stage and env.get('SELLER_TABLE'):
                table = env['SELLER_TABLE']
if not table:
    sys.exit(f'No {stage} site found')
print('Table', table)
D = boto3.resource('dynamodb').Table(table)
rows = []
kw = {}
while True:
    r = D.scan(**kw); rows += r['Items']
    if 'LastEvaluatedKey' not in r: break
    kw['ExclusiveStartKey'] = r['LastEvaluatedKey']
now = datetime.datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%S.000Z')

def card_of(x):
    v = x.get('rateCard')
    for _ in range(2):
        if isinstance(v, str):
            try: v = json.loads(v)
            except Exception: v = {}
    return v if isinstance(v, dict) else {}

def fill(mine, add):
    if not isinstance(add, dict): return add if mine is None else mine
    o = dict(mine) if isinstance(mine, dict) else {}
    for k, v in add.items(): o[k] = fill(o.get(k), v)
    return o

added = updated = 0
for c in json.load(open(src)):
    name, est = c['name'], c['card']
    same = next((x for x in rows if x.get('type') == 'COURIER' and str(x.get('business', '')).lower() == name.lower()), None)
    appr = next((x for x in rows if x.get('type') == 'COURIER' and x.get('status') == 'APPROVED' and str(x.get('business', '')).strip().lower() == str(c.get('approvedName', '')).lower()), None) if c.get('approvedName') else None
    if appr:
        cur = card_of(appr)
        nxt = {**cur, 'uae': fill(cur.get('uae'), est.get('uae')), 'intl': fill(cur.get('intl'), est.get('intl')),
               'country': fill(cur.get('country'), est.get('country')), 'from': cur.get('from') or est.get('from'), 'notes': cur.get('notes') or est.get('notes'), 'at': now}
        D.update_item(Key={'id': appr['id']}, UpdateExpression='SET rateCard = :c, updatedAt = :u', ExpressionAttributeValues={':c': json.dumps(nxt, ensure_ascii=False), ':u': now})
        updated += 1; print('  filled empty prices of', appr.get('business'))
        if not same: continue
    if same:
        if same.get('status') == 'PROSPECT' and card_of(same).get('basis') != 'list':
            D.update_item(Key={'id': same['id']}, UpdateExpression='SET rateCard = :c, updatedAt = :u', ExpressionAttributeValues={':c': json.dumps(est, ensure_ascii=False), ':u': now})
            updated += 1; print('  refreshed', name)
        continue
    item = {'id': f'pro-{uuid.uuid4()}', '__typename': 'SellerProfile', 'createdAt': now, 'updatedAt': now, 'appliedAt': now,
            'type': 'COURIER', 'status': 'PROSPECT', 'business': name, 'contactName': name, 'address': c.get('based') or None,
            'rateCard': json.dumps(est, ensure_ascii=False), 'phone': c.get('phone') or None, 'email': (c.get('email') or '').lower() or None,
            'city': (c.get('based') or '')[:80] or None, 'country': 'India' if 'india' in (c.get('based') or '').lower() else 'UAE',
            'mediums': (c.get('work') or '')[:200] or None, 'about': c.get('work') or None, 'portfolio': c.get('link') or None,
            'outreach': 'To contact', 'commissionPct': 0, 'sampleKeys': '[]'}
    D.put_item(Item={k: v for k, v in item.items() if v is not None})
    added += 1; print('  added', name)
print(f'Done: {added} added, {updated} updated.')
