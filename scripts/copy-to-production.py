#!/usr/bin/env python3
"""Copy the Kalai Art House data from the TEST site to the new PRODUCTION site (run in AWS CloudShell).

  python3 copy-to-production.py                 # dry run: shows what would be copied
  python3 copy-to-production.py --go            # copies the masters and the pictures
  python3 copy-to-production.py --go --orders KA-261025-Q3X0,KA-261025-32ET   # also these real orders
  python3 copy-to-production.py --go --customers                             # also the customer master

What it copies (only rows the production site doesn't have yet; nothing is deleted or overwritten):
  catalogue (Product, ArtworkPrice), artists / sellers / suppliers (SellerProfile, Listing, MarketItem, ArtistProfile),
  offers (Promotion, Announcement), settings (SiteSetting, Rates), saved translations (Translation),
  and the pictures in storage (catalogue/, market/, originals/).
Not copied unless asked: orders (test orders stay on the test site), customers, vouchers, uploads.
Accounts (sign-ins) are not copied: people sign up again on the live site with the same email. An artist's or
supplier's profile then joins their new account by itself at their first sign-in.
"""
import argparse, sys, boto3

ap = argparse.ArgumentParser()
ap.add_argument('--go', action='store_true', help='really copy (default: dry run)')
ap.add_argument('--orders', default='', help='comma-separated order numbers (KA-…) to copy, with their costing')
ap.add_argument('--customers', action='store_true', help='also copy the customer master (BP-…)')
ap.add_argument('--vouchers', action='store_true', help='also copy vouchers / gift cards')
ap.add_argument('--uploads', action='store_true', help='also copy customer uploads (uploads/)')
a = ap.parse_args()

lam, ddb, s3 = boto3.client('lambda'), boto3.client('dynamodb'), boto3.client('s3')

# The two sites: each one's function says which it is (KALAI_STAGE) and names its tables and bucket.
sites = {}
for page in lam.get_paginator('list_functions').paginate():
    for f in page['Functions']:
        if 'zohoquotesync' not in f['FunctionName'].replace('-', '').lower():
            continue
        env = lam.get_function_configuration(FunctionName=f['FunctionName']).get('Environment', {}).get('Variables', {})
        if 'ENQUIRY_TABLE' in env:
            sites[env.get('KALAI_STAGE', 'test')] = env
if 'prod' not in sites or 'test' not in sites:
    sys.exit(f"Found sites: {list(sites)}. Both the test site (main) and the production branch must be deployed first.")
T, P = sites['test'], sites['prod']
print(f"TEST  tables …{T['ENQUIRY_TABLE'][-30:]}  bucket {T['UPLOADS_BUCKET']}")
print(f"PROD  tables …{P['ENQUIRY_TABLE'][-30:]}  bucket {P['UPLOADS_BUCKET']}")

def scan(table):
    for page in ddb.get_paginator('scan').paginate(TableName=table):
        yield from page['Items']

def key_of(table):
    return [k['AttributeName'] for k in ddb.describe_table(TableName=table)['Table']['KeySchema']]

def copy(env_name, rows=None, change=None):
    src, dst = T.get(env_name), P.get(env_name)
    if not src or not dst:
        print(f"  {env_name}: not set up, skipped"); return
    keys = key_of(dst)
    have = {tuple(str(i[k]) for k in keys) for i in scan(dst)}
    n = 0
    for item in (rows if rows is not None else scan(src)):
        if tuple(str(item[k]) for k in keys) in have:
            continue
        if change:
            item = change(item)
        n += 1
        if a.go:
            ddb.put_item(TableName=dst, Item=item)
    print(f"  {env_name[:-6].title():14} {n} new row(s){'' if a.go else ' (dry run)'}")

def mark_migrated(item):
    # Profiles join the person's new live-site account at their first sign-in (same email).
    item = dict(item); item['migrated'] = {'BOOL': True}; return item

print('\nData:')
for t in ['PRODUCT_TABLE', 'ARTPRICE_TABLE', 'LISTING_TABLE', 'MARKET_TABLE', 'ARTIST_TABLE', 'PROMO_TABLE',
          'ANNOUNCE_TABLE', 'SITE_TABLE', 'RATES_TABLE', 'TRANSLATION_TABLE']:
    copy(t)
copy('SELLER_TABLE', change=mark_migrated)
if a.customers:
    copy('CUSTOMER_TABLE')
if a.vouchers:
    copy('VOUCHER_TABLE')
if a.orders:
    refs = {r.strip() for r in a.orders.split(',') if r.strip()}
    orders = [i for i in scan(T['ENQUIRY_TABLE']) if i.get('ref', {}).get('S') in refs]
    ids = {i['id']['S'] for i in orders}
    print(f"  orders found: {sorted(i['ref']['S'] for i in orders)}; missing: {sorted(refs - {i['ref']['S'] for i in orders})}")
    copy('ENQUIRY_TABLE', rows=orders)
    copy('COSTING_TABLE', rows=[c for c in scan(T['COSTING_TABLE']) if c.get('enquiryId', {}).get('S') in ids])

print('\nPictures:')
prefixes = ['catalogue/', 'market/', 'originals/'] + (['uploads/'] if a.uploads else [])
for pre in prefixes:
    have = set()
    for page in s3.get_paginator('list_objects_v2').paginate(Bucket=P['UPLOADS_BUCKET'], Prefix=pre):
        have |= {o['Key'] for o in page.get('Contents', [])}
    n = 0
    for page in s3.get_paginator('list_objects_v2').paginate(Bucket=T['UPLOADS_BUCKET'], Prefix=pre):
        for o in page.get('Contents', []):
            if o['Key'] in have:
                continue
            n += 1
            if a.go:
                s3.copy_object(Bucket=P['UPLOADS_BUCKET'], Key=o['Key'], CopySource={'Bucket': T['UPLOADS_BUCKET'], 'Key': o['Key']})
    print(f"  {pre:12} {n} file(s){'' if a.go else ' (dry run)'}")
print('\nDone.' if a.go else '\nDry run only: add --go to copy.')
