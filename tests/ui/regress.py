"""Regression checks for the Kalai screens, run before every push to main / production.

  python3 tests/ui/regress.py            # builds the stubbed site, runs every check, exits 1 on any failure

Each check seeds the stub database (localStorage 'stubdb'), opens a page and asserts what a person would see.
When a bug is found (in testing or by Anis), add a check here so it can't come back.
"""
import json, re, os, socket, subprocess, sys, tempfile, threading, time, traceback
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from functools import partial
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = tempfile.mkdtemp(prefix='kalai-ui-')
subprocess.run([sys.executable, os.path.join(HERE, 'build.py'), OUT], check=True, stdout=subprocess.DEVNULL)
sock = socket.socket(); sock.bind(('127.0.0.1', 0)); PORT = sock.getsockname()[1]; sock.close()
srv = ThreadingHTTPServer(('127.0.0.1', PORT), partial(type('Q', (SimpleHTTPRequestHandler,), {'log_message': lambda *a: None}), directory=OUT))
threading.Thread(target=srv.serve_forever, daemon=True).start()
BASE = f'http://127.0.0.1:{PORT}'

ADMIN = {'admin@kalai.com': {'password': 'S', 'confirmed': True, 'groups': ['ADMINS']}}
SELLERS = [
    {'id': 'c1', 'type': 'COURIER', 'status': 'APPROVED', 'business': 'ARAMAX', 'rateCard': json.dumps({'uae': {'Dubai': {'s1': 22, '40×50': 35}}})},
    {'id': 'f1', 'type': 'FRAMER', 'status': 'APPROVED', 'business': 'Rafi Frames', 'rateCard': '{}'},
    {'id': 'p1', 'type': 'PRINTER', 'status': 'APPROVED', 'business': 'Print Hub', 'rateCard': '{}'},
]
def order(**kw):
    o = {'id': 'e1', 'ref': 'KA-261020-YWXE', 'kind': 'PRICE', 'title': 'Lily Pond Steps', 'status': 'FRAMING', 'quotedPrice': 500,
         'createdAt': '2026-10-21T08:00:00Z', 'zohoInvoiceId': 'x', 'customerName': 'Ponns',
         'details': json.dumps({'Artwork': 'Lily Pond Steps (Watercolour on paper, 38 × 28 cm)', 'Framing': 'Framed, ready to hang', 'Size': 'Medium · 40 × 50 cm'})}
    o.update(kw); return o

RESULTS = []
def check(name):
    def wrap(fn):
        RESULTS.append((name, fn)); return fn
    return wrap

def open_page(b, path, seed, wait=2500, width=1400):
    pg = b.new_page(viewport={'width': width, 'height': 1000}); errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto(f'{BASE}/{path.split("#")[0].split("?")[0]}')
    pg.evaluate(f"localStorage.clear();localStorage.setItem('stubdb',JSON.stringify({json.dumps(seed)}))")
    pg.goto(f'{BASE}/{path}'); pg.reload(); pg.wait_for_timeout(wait)
    return pg, errs

def need(cond, msg):
    if not cond: raise AssertionError(msg)

# ---------------------------------------------------------------- Order Management: supplier boxes
@check('Order: artist-typed courier + AWB shows in Artist → Frame shop (was blank)')
def _(b):
    seed = {'users': ADMIN, 'session': 'admin@kalai.com', 'sellers': SELLERS,
            'items': [order(artistStage='SHIPPED', artistCourier='DHL', artistAwb='DHL0000007', artistShippedAt='2026-10-27T06:00:00Z')],
            'costing': [{'enquiryId': 'e1', 'supplierJobs': json.dumps({'framer': {'supplierId': 'f1', 'name': 'Rafi Frames', 'stage': 'READY', 'price': 75}})}]}
    pg, errs = open_page(b, 'admin.html#order=e1', seed)
    t = pg.inner_text('#supplierBox')
    need('DHL0000007' in t and 'entered by the artist' in t, 'artist AWB not shown in the courier box')
    need('Arrived' in t, 'artist parcel should show Arrived once the frame shop has it')
    need('not allocated: the artist types' not in t, 'still says not allocated')
    return errs

@check('Order: one box per party + flow by order kind (Collection)')
def _(b):
    seed = {'users': ADMIN, 'session': 'admin@kalai.com', 'sellers': SELLERS, 'items': [order()], 'costing': []}
    pg, errs = open_page(b, 'admin.html#order=e1', seed)
    t = pg.inner_text('#supplierBox')
    for w in ['Artist → Frame shop → Customer', '🎨 ARTIST', '🖼 FRAME SHOP', '🚚 COURIER', 'Frame shop → Customer']:
        need(w in t, f'missing "{w}"')
    need('PRINT SHOP' not in t, 'Collection order should not show a print shop box')
    return errs

@check('Day to Day ready-made frames are used for Little Artists only; original artworks keep the frame shop')
def _(b):
    dtd = {'id': 'd2d', 'type': 'FRAMER', 'status': 'APPROVED', 'business': 'Day to Day', 'rateCard': json.dumps({'frames': {'black': {'A4': 11.99, '30×40': 15.99}, 'white': {'A4': 11.99, '30×40': 15.99}}, 'fixingIncluded': True, 'onlyFor': ['GIFT', 'PHOTO']})}
    rafi = dict(SELLERS[1], rateCard=json.dumps({'frames': {'black': {'A4': 40, '30×40': 70}, 'white': {'A4': 40, '30×40': 70}}, 'fixingIncluded': True}))
    sellers = [SELLERS[0], rafi, SELLERS[2], dtd]
    gift = order(id='g1', kind='GIFT', title='Little Artists', details=json.dumps({'Frame': 'Black'}))
    seed = {'users': ADMIN, 'session': 'admin@kalai.com', 'sellers': sellers, 'items': [gift],
            'costing': [{'enquiryId': 'g1', 'supplierJobs': json.dumps({'printer': {'supplierId': 'p1', 'name': 'Print Hub', 'stage': 'READY', 'price': 5}})}]}
    pg, errs = open_page(b, 'admin.html#order=g1', seed)
    need(pg.input_value('[data-js="framer-price"]') in ('11.99', '12'), f"Little Artists frame price {pg.input_value('[data-js=framer-price]')} (Day to Day ⃃11.99)")
    art = order(id='a1', kind='PRICE', title='Small work', details=json.dumps({'Framing': 'Black frame 30×40 cm'}), status='PAID')
    seed2 = {'users': ADMIN, 'session': 'admin@kalai.com', 'sellers': sellers, 'items': [art], 'costing': []}
    pg2, errs2 = open_page(b, 'admin.html#order=a1', seed2)
    need(pg2.input_value('[data-js="framer-price"]') == '70', f"original artwork frame price {pg2.input_value('[data-js=framer-price]')} (frame shop ⃃70, not Day to Day)")
    return errs + errs2

@check('Collection order without a frame size is costed at the frame that fits the work (HDHX: 21 × 30 cm → 30×40, not 40×50)')
def _(b):
    rafi = dict(SELLERS[1], rateCard=json.dumps({'frames': {'black': {'30×40': 70, '40×50': 75}}, 'fixingIncluded': True}))
    it = order(id='h1', ref='KA-261021-HDHX', title='Coconut Palm', status='RECEIVED', quotedPrice=None, zohoInvoiceId=None,
               details=json.dumps({'Artwork': 'Coconut Palm (Pen and ink on paper, 21 × 30 cm)', 'Framing': 'Framed, ready to hang'}))
    seed = {'users': ADMIN, 'session': 'admin@kalai.com', 'sellers': [SELLERS[0], rafi, SELLERS[2]], 'items': [it], 'costing': [{'enquiryId': 'h1', 'artistPriceInr': 2000}]}
    pg, errs = open_page(b, 'admin.html#order=h1', seed)
    out = pg.inner_text('#costOut')
    need('30×40' in out and '⃃ 70' in out, f'framing not at 30×40: {out[:200]}')
    return errs

@check('Frame job carries the frame to make (65CF: Guddis only saw "Framed, ready to hang")')
def _(b):
    rafi = dict(SELLERS[1], rateCard=json.dumps({'frames': {'black': {'40×50': 75}}, 'fixingIncluded': True}))
    it = order(id='p6', ref='KA-261022-65CF', title='Plank Bridge Over the Stream', status='PAID',
               details=json.dumps({'Artwork': 'Plank Bridge Over the Stream (Watercolour on paper, 38 × 28 cm)', 'Framing': 'Framed, ready to hang'}))
    seed = {'users': ADMIN, 'session': 'admin@kalai.com', 'sellers': [SELLERS[0], rafi, SELLERS[2]], 'items': [it], 'costing': [{'enquiryId': 'p6', 'artistPriceInr': 3350}]}
    pg, errs = open_page(b, 'admin.html#order=p6', seed)
    pg.locator('[data-jobsend="framer"]').click(); pg.wait_for_timeout(1500)
    jobs = pg.evaluate("JSON.parse(JSON.parse(localStorage.getItem('stubdb')).costing.find(c => c.enquiryId === 'p6').supplierJobs)")
    need(jobs.get('framer', {}).get('spec') == 'Black slim frame 40×50 cm, white mount, glass', f"frame job spec: {jobs.get('framer', {}).get('spec')}")
    src = open(os.path.join(os.path.dirname(os.path.dirname(HERE)), 'amplify', 'functions', 'zoho-quote-sync', 'handler.ts')).read()
    need("['Frame to make', String(j.spec)]" in src, 'server does not show the frame to make to the frame shop')
    need('has(c)' in src[src.index('function addressText'):src.index('function addressText') + 900], 'address repeats the country')
    return errs

@check('Order: Little Artists flow Print shop → Frame shop → Customer')
def _(b):
    seed = {'users': ADMIN, 'session': 'admin@kalai.com', 'sellers': SELLERS,
            'items': [order(id='g1', kind='GIFT', title='Little Artists', details='{}')],
            'costing': [{'enquiryId': 'g1', 'supplierJobs': json.dumps({'printer': {'supplierId': 'p1', 'name': 'Print Hub', 'stage': 'READY', 'price': 20}, 'framer': {'supplierId': 'f1', 'name': 'Rafi Frames', 'stage': 'ACCEPTED', 'price': 75}})}]}
    pg, errs = open_page(b, 'admin.html#order=g1', seed)
    t = pg.inner_text('#supplierBox')
    for w in ['Print shop → Frame shop → Customer', 'PRINT SHOP', 'Print shop → Frame shop', 'collects it from Print Hub']:
        need(w in t, f'missing "{w}"')
    need('🎨 ARTIST' not in t, 'Little Artists order should not show an artist box')
    return errs

@check('Order: cheapest courier pre-selected with price even without an address')
def _(b):
    seed = {'users': ADMIN, 'session': 'admin@kalai.com', 'sellers': SELLERS, 'items': [order()],
            'costing': [{'enquiryId': 'e1', 'supplierJobs': json.dumps({'framer': {'supplierId': 'f1', 'name': 'Rafi Frames', 'stage': 'READY', 'price': 75}})}]}
    pg, errs = open_page(b, 'admin.html#order=e1', seed)
    need(pg.input_value('[data-js="delivery-sid"]') == 'c1', 'ARAMAX not pre-selected')
    need(pg.input_value('[data-js="delivery-price"]') == '35', 'courier price not prefilled')
    need('Dubai (assumed' in pg.inner_text('#supplierBox'), 'no "Dubai (assumed)" note')
    return errs

@check('Order: a failed "Send the job" shows a clear red error (was easy to miss)')
def _(b):
    seed = {'users': ADMIN, 'session': 'admin@kalai.com', 'sellers': SELLERS, 'items': [order()], 'costing': [], 'listings': []}
    pg, errs = open_page(b, 'admin.html#order=e1', seed)
    pg.select_option('[data-js="framer-sid"]', 'f1'); pg.evaluate("localStorage.setItem('failNext','1')")
    pg.locator('[data-jobsend="framer"]').click(); pg.wait_for_timeout(1200)
    m = pg.locator('[data-jobmsg="framer"]')
    need('Not sent' in m.inner_text(), f'no clear failure message: "{m.inner_text()}"')
    need(m.evaluate('e => e.style.fontWeight') == '700', 'failure message not bold/red')
    return errs


# ---------------------------------------------------------------- Order Management: price, voucher, helper card (test of KA-261021-X3BT)
def priced_seed(**kw):
    it = order(id='x1', ref='KA-261021-X3BT', title='Old Town Lane', status='RECEIVED', quotedPrice=None, zohoInvoiceId=None, email='a@x.com',
               details=json.dumps({'Artwork': 'Old Town Lane (Pen and ink on paper, 28 × 40 cm)', 'Framing': 'Framed, ready to hang'}), **kw)
    return {'users': ADMIN, 'session': 'admin@kalai.com', 'sellers': SELLERS, 'items': [it], 'listings': [],
            'costing': [{'enquiryId': 'x1', 'artistPriceInr': 9000}],
            'promos': [{'code': 'DIWALI10', 'discountType': 'PCT', 'discountValue': 10, 'status': 'LIVE'}]}

@check('Costing: size tier taken from the artwork size (28 × 40 cm → M) and used in the costing')
def _(b):
    pg, errs = open_page(b, 'admin.html#order=x1', priced_seed())
    need(pg.input_value('#cTier') == 'M', f'size tier not guessed: "{pg.input_value("#cTier")}"')
    need('master M' in pg.inner_text('#costOut'), 'costing not worked out from the guessed tier')
    return errs

@check('Voucher: applying a code keeps unsaved inputs (size tier, message)')
def _(b):
    pg, errs = open_page(b, 'admin.html#order=x1', priced_seed())
    pg.select_option('#cTier', 'L'); pg.fill('#eMsg', 'hello test')
    pg.fill('#ePrice', '925'); pg.select_option('#eDiscT', 'CODE'); pg.wait_for_timeout(300)
    pg.fill('#eVch', 'DIWALI10'); pg.click('#eVchApply'); pg.wait_for_timeout(1500)
    need(pg.input_value('#cTier') == 'L', 'size tier was reset by applying the code')
    need(pg.input_value('#eMsg') == 'hello test', 'message was lost by applying the code')
    need('832.5' in pg.inner_text('#detail'), '925 − 10% should show 832.50')
    return errs

@check('Offer order (KA-…-HDHX): customer\'s standard 25% is not shown as applied (quote and link stay at the offer); a normal order still gets it')
def _(b):
    cust = [{'code': 'C1', 'name': 'Ananya', 'discountType': 'PCT', 'discountValue': 25, 'discountNote': 'Senior citizens (60+)', 'discountArea': 'ALL'}]
    s = priced_seed(customerCode='C1'); s['customers'] = cust
    s['items'][0]['details'] = json.dumps({'Artwork': 'Coconut Palm (Pen and ink on paper, 21 × 30 cm)', 'Offer': 'AED 150'})
    pg, errs = open_page(b, 'admin.html#order=x1', s); pg.wait_for_timeout(1500)
    need(pg.input_value('#eDiscT') == '', f"standard discount filled on an offer order ({pg.input_value('#eDiscT')})")
    need(pg.locator('#eStdOffer').count() == 1 and '25%' in pg.inner_text('#eStdOffer'), 'no note that the standard discount is not added to the offer')
    s2 = priced_seed(customerCode='C1'); s2['customers'] = cust
    pg2, errs2 = open_page(b, 'admin.html#order=x1', s2); pg2.wait_for_timeout(1500)
    need(pg2.input_value('#eDiscT') == 'PCT' and pg2.input_value('#eDiscV') == '25', 'normal order lost the standard discount')
    return errs + errs2

@check('Costing follows the delivery address (KA-261022-65CF: address India, old costing said United States)')
def _(b):
    s = priced_seed(deliveryCountry='India', deliveryEmirate='Tamil Nadu', deliveryAddress='26/6 Carmel Street, Nagercoil', deliveryPin='629004')
    s['costing'] = [{'enquiryId': 'x1', 'artistPriceInr': 9000, 'costs': json.dumps({'delivery': 'OUTSIDE', 'destCountry': 'United States', 'destRegion': 'Califoria', 'shipFrom': 'UAE'})}]
    pg, errs = open_page(b, 'admin.html#order=x1', s); pg.wait_for_timeout(800)
    need(pg.input_value('#cDel') == 'OUTSIDE', 'delivery not outside the UAE')
    need(pg.input_value('#cDestCountry') == 'India', f"costing destination {pg.input_value('#cDestCountry')} (address is India)")
    need(pg.input_value('#cDestRegion') == 'Tamil Nadu', f"region {pg.input_value('#cDestRegion')}")
    need('United States' not in pg.inner_text('#costOut'), 'US courier still in the costing')
    return errs

@check('Orders: searching an order number finds an older order even with the 2-day date filter; #order=KA-… opens it')
def _(b):
    s = priced_seed(createdAt='2026-10-01T08:00:00Z')
    pg, errs = open_page(b, 'admin.html', s); pg.wait_for_timeout(500)
    if not pg.input_value('#fFrom'): pg.fill('#fFrom', '2026-10-27'); pg.dispatch_event('#fFrom', 'change')
    pg.fill('#fSearch', 'X3BT'); pg.wait_for_timeout(600)
    need('KA-261021-X3BT' in pg.inner_text('#ordersTable, table'), 'order number search hidden by the dates')
    pg2, errs2 = open_page(b, 'admin.html#order=KA-261021-X3BT', s); pg2.wait_for_timeout(800)
    need('Old Town Lane' in pg2.inner_text('#detail'), '#order=<order no.> does not open the order')
    return errs + errs2

@check('What next card never stays on top of the Save button')
def _(b):
    pg, errs = open_page(b, 'admin.html#order=x1', priced_seed(), width=1500)
    need(pg.is_visible('#nhBox'), 'card should open with the order')
    pg.mouse.wheel(0, 300); pg.wait_for_timeout(300)
    need(not pg.is_visible('#nhBox'), 'card did not fold on scroll')
    pg.locator('#eSave').scroll_into_view_if_needed()
    covered = pg.evaluate("""() => { const b = document.getElementById('eSave').getBoundingClientRect();
        const t = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2); return !document.getElementById('eSave').contains(t); }""")
    need(not covered, 'Save button covered')
    return errs

@check('"Email the customer again" names the status (was empty brackets)')
def _(b):
    pg, errs = open_page(b, 'admin.html#order=x1', priced_seed())
    t = pg.inner_text('#detail')
    need('again ()' not in t, 'empty brackets in Email the customer again')
    return errs


@check('Artists & sellers: tab count drops right after rejecting an application (still showed (1))')
def _(b):
    seed = {'users': ADMIN, 'session': 'admin@kalai.com', 'listings': [], 'items': [], 'costing': [],
            'sellers': SELLERS + [{'id': 'k1', 'type': 'FRAMER', 'status': 'APPLIED', 'business': 'KUMAR ANis', 'contactName': 'Kumar', 'phone': '+97155', 'appliedAt': '2026-10-27T08:00:00Z'}]}
    pg, errs = open_page(b, 'admin.html#sellers', seed, wait=3000)
    need('(1)' in pg.inner_text('#tabSellers'), 'no pending count to start with')
    act = pg.locator('.mk-act', has=pg.locator('[data-a="rejectSeller"]')).first
    act.locator('input[data-f="note"]').fill('Test registration')
    act.locator('[data-a="rejectSeller"]').click(); pg.wait_for_timeout(1500)
    need('(1)' not in pg.inner_text('#tabSellers'), 'tab still shows (1) after rejecting')
    return errs


@check('Order screen: no sideways scroll, wide window to phone (Action column, header)')
def _(b):
    seed = {'users': ADMIN, 'session': 'admin@kalai.com', 'sellers': SELLERS, 'listings': [], 'site': {'id': 'site', 'orderLayout': 'b'},
            'items': [order(id='g2', kind='GIFT', title='Little Artists gift for Appa', status='RECEIVED', quotedPrice=None, zohoInvoiceId=None, discountType='PCT', discountValue=25,
                            details=json.dumps({'Card message': 'to appa', 'Frame': 'white', 'Total': 'AED 104', 'Gift for': 'Appa'}))], 'costing': []}
    bad = []
    for w in (1885, 1500, 1280, 474, 390):
        pg, errs = open_page(b, 'admin.html#order=g2', seed, width=w); pg.wait_for_timeout(800)
        sw, cw = pg.evaluate('[document.documentElement.scrollWidth, document.documentElement.clientWidth]')
        if sw > cw + 1: bad.append(f'{w}px: page is {sw}px wide')
        pg.close()
    need(not bad, '; '.join(bad))
    return []


@check('Little Artists order: price taken from "Total AED 104" (was empty)')
def _(b):
    seed = {'users': ADMIN, 'session': 'admin@kalai.com', 'sellers': SELLERS, 'listings': [], 'costing': [],
            'items': [order(id='g3', kind='GIFT', title='Little Artists gift for Appa', status='RECEIVED', quotedPrice=None, zohoInvoiceId=None,
                            details=json.dumps({'Frame': 'white', 'Total': 'AED 104'}))]}
    pg, errs = open_page(b, 'admin.html#order=g3', seed)
    need(pg.input_value('#ePrice') == '104', f'price box: "{pg.input_value("#ePrice")}"')
    return errs


@check('Commission costing: "Medium · 40 × 50 cm" → tier M, teak frame = wood, delivery to India → Outside UAE')
def _(b):
    it = order(id='c7', ref='KA-261022-77QM', kind='COMMISSION', title='Commission: Pet portrait (Watercolour)', status='RECEIVED', quotedPrice=None, zohoInvoiceId=None,
               deliveryCountry='India', deliveryEmirate='Tamil Nadu',
               details=json.dumps({'Frame': 'Teak frame', 'Size': 'Medium · 40 × 50 cm', 'Style': 'Watercolour', 'Subject': 'Pet portrait'}))
    seed = {'users': ADMIN, 'session': 'admin@kalai.com', 'sellers': SELLERS, 'listings': [], 'items': [it], 'costing': [{'enquiryId': 'c7'}]}
    pg, errs = open_page(b, 'admin.html#order=c7', seed)
    need(pg.input_value('#cTier') == 'M', f'tier {pg.input_value("#cTier")} (should be M for Medium)')
    need(pg.input_value('#cDel') == 'OUTSIDE', 'delivery to India still costed as UAE')
    return errs


@check('Commission: saving with an empty artist-price box keeps the artist\'s price (Siva\'s ₹12,000 was wiped)')
def _(b):
    it = order(id='c9', ref='KA-261022-77QM', kind='COMMISSION', title='Commission: Pet portrait', status='PRICE_SENT', quotedPrice=1875, zohoInvoiceId=None, email='h@x.com',
               details=json.dumps({'Frame': 'Teak frame', 'Size': 'Medium · 40 × 50 cm'}))
    seed = {'users': ADMIN, 'session': 'admin@kalai.com', 'sellers': SELLERS, 'listings': [], 'items': [it], 'costing': [{'enquiryId': 'c9', 'artistPriceInr': 12000}]}
    pg, errs = open_page(b, 'admin.html#order=c9', seed)
    pg.fill('#cInr', ''); pg.select_option('#ePayMethod', 'OTHER'); pg.fill('#ePayRef', 'R'); pg.select_option('#eStatus', 'PAID'); pg.click('#eSave'); pg.wait_for_timeout(2500)
    v = pg.evaluate("JSON.parse(localStorage.stubdb).costing[0].artistPriceInr")
    need(v == 12000, f'artist price after save: {v}')
    return errs


@check('India customer + artist in India: India frame shop and India courier come first, no UAE customs')
def _(b):
    card_in = json.dumps({'frames': {'oak': {'40×50': 82}}, 'fixingIncluded': True, 'from': 'India'})
    card_ae = json.dumps({'frames': {'oak': {'40×50': 60}}, 'fixingIncluded': True})
    sellers = SELLERS + [{'id': 'fin', 'type': 'FRAMER', 'status': 'APPROVED', 'business': 'FNM Custom Framing', 'country': 'India', 'rateCard': card_in},
                         {'id': 'fae', 'type': 'FRAMER', 'status': 'APPROVED', 'business': 'Dubai Frames', 'rateCard': card_ae},
                         {'id': 'cin', 'type': 'COURIER', 'status': 'APPROVED', 'business': 'DTDC', 'rateCard': json.dumps({'from': 'India', 'country': {'India': {'40×50': 12}}})}]
    it = order(id='c10', ref='KA-261022-77QM', kind='COMMISSION', title='Commission: Pet portrait', status='PAID', quotedPrice=1875, zohoInvoiceId='x',
               deliveryCountry='India', deliveryEmirate='Tamil Nadu', details=json.dumps({'Frame': 'Teak frame', 'Size': 'Medium · 40 × 50 cm'}))
    seed = {'users': ADMIN, 'session': 'admin@kalai.com', 'sellers': sellers, 'listings': [], 'items': [it], 'costing': [{'enquiryId': 'c10', 'artistPriceInr': 12000}]}
    pg, errs = open_page(b, 'admin.html#order=c10', seed)
    need(pg.input_value('[data-js="framer-sid"]') == 'fin', f'frame shop pre-selected: {pg.input_value("[data-js=framer-sid]")}')
    need(pg.input_value('#cShipFrom') == 'India', 'ships from should default to India')
    out = pg.inner_text('#costOut')
    need('FNM Custom Framing' in out, 'costing does not use the India frame shop')
    need('Customs' not in out or '⃃ 0' in out.split('Customs')[1][:20], 'UAE customs charged on an India-to-India order')
    return errs


@check('After Siva\'s order is placed, "Ships from" can still be changed and saved (it reverted to UAE)')
def _(b):
    it = order(id='c12', ref='KA-261022-77QM', kind='COMMISSION', title='Commission', status='PAID', quotedPrice=1875, zohoInvoiceId='x', zohoPOId='po',
               deliveryCountry='India', deliveryEmirate='Tamil Nadu', details=json.dumps({'Frame': 'Teak frame', 'Size': 'Medium · 40 × 50 cm'}))
    seed = {'users': ADMIN, 'session': 'admin@kalai.com', 'sellers': SELLERS, 'listings': [], 'items': [it],
            'costing': [{'enquiryId': 'c12', 'artistPriceInr': 12000, 'delivery': 'OUTSIDE', 'sizeTier': 'M', 'costs': json.dumps({'shipFrom': 'UAE', 'destCountry': 'India'})}]}
    pg, errs = open_page(b, 'admin.html#order=c12', seed)
    pg.select_option('#ePayMethod', 'OTHER'); pg.fill('#ePayRef', 'R')
    pg.select_option('#cShipFrom', 'India'); pg.click('#eSave'); pg.wait_for_timeout(2500)
    c = pg.evaluate("JSON.parse(localStorage.stubdb).costing[0]")
    costs = json.loads(c['costs']) if isinstance(c.get('costs'), str) else c.get('costs')
    need(costs.get('shipFrom') == 'India', f'ships from saved as {costs.get("shipFrom")}')
    need(c.get('artistPriceInr') == 12000, 'artist price changed')
    return errs

# ---------------------------------------------------------------- Supplier portal
def sup_seed(session, jobs):
    users = {**ADMIN, 'rafi@x.com': {'password': 'S', 'confirmed': True, 'groups': []}}
    sellers = [dict(SELLERS[1], id='rafi@x.com')] + SELLERS
    return {'users': users, 'session': session, 'sellers': sellers, 'items': [], 'supJobs': jobs, 'listings': []}
JOB = {'id': 'e1', 'role': 'framer', 'ref': 'KA-261020-YWXE', 'title': 'Lily Pond Steps', 'kind': 'PRICE', 'stage': 'READY', 'price': 75, 'specs': [], 'from': None, 'to': {'name': 'Ponns', 'address': 'Al Barsha'}}

@check('Supplier: invoiced frame still waiting for pickup stays in To do')
def _(b):
    pg, errs = open_page(b, 'supplier.html', sup_seed('rafi@x.com', [dict(JOB, invoiceNo='T-RF1', invoiceAmt=75)]))
    need('KA-261020-YWXE' in pg.inner_text('#jList'), 'invoiced READY job dropped out of To do')
    return errs

@check('Supplier price list: old dirham figures of a shop in India open as ⃃; choosing ₹ converts the amounts and relabels the text')
def _(b):
    seed = sup_seed('rafi@x.com', [JOB])
    seed['sellers'][0] = dict(seed['sellers'][0], address='Bengaluru, India', rateCard=json.dumps({'frames': {'black': {'40×50': 63}}, 'from': 'India', 'basis': 'est'}))
    seed['site'] = {'id': 'site', 'inrPerAed': 24}
    pg, errs = open_page(b, 'supplier.html', seed)
    pg.click('[data-t="rates"]'); pg.wait_for_timeout(800)
    need(pg.input_value('#rCur') == 'AED', f"old ⃃ list shown as {pg.input_value('#rCur')}")
    need('in ⃃' in pg.inner_text('#rNote'), 'note not in ⃃')
    pg.select_option('#rCur', 'INR'); pg.wait_for_timeout(200)
    need('in ₹' in pg.inner_text('#rNote'), 'note still says ⃃ after choosing rupees')
    v = pg.input_value('[data-n="frames.black.40×50"]')
    need(v == '1510', f'⃃63 not converted to ₹ at 24 (shows {v})')
    need('converted' in pg.inner_text('#rCurHint'), 'no note that the amounts were converted')
    pg.select_option('#rCur', 'AED'); pg.wait_for_timeout(300)
    v = pg.input_value('[data-n="frames.black.40×50"]')
    need(abs(float(v) - 62.92) < 0.01, f'back to ⃃ gives {v}')
    return errs

@check('Supplier: order search box + drop-down filter the jobs')
def _(b):
    jobs = [JOB, dict(JOB, id='e2', ref='KA-261025-AAAA', title='Other work', to={'name': 'Zed', 'address': 'Marina'})]
    pg, errs = open_page(b, 'supplier.html', sup_seed('rafi@x.com', jobs))
    need(pg.locator('#jPick option').count() == 3, 'order drop-down not filled')
    pg.fill('#jQ', 'zed'); pg.wait_for_timeout(300)
    t = pg.inner_text('#jList')
    need('KA-261025-AAAA' in t and 'KA-261020-YWXE' not in t, 'search did not filter')
    return errs

@check('Supplier: non-admin never sees the studio bar')
def _(b):
    pg, errs = open_page(b, 'supplier.html', sup_seed('rafi@x.com', [JOB]))
    need(not pg.is_visible('#adminBar'), 'studio bar visible to a supplier')
    need(pg.locator('.sn-bar').count() == 0, 'studio drop-downs present for a supplier')
    return errs

@check('Supplier: admin sees the studio bar marked Admin only; sign-out hides it')
def _(b):
    pg, errs = open_page(b, 'supplier.html', sup_seed('admin@kalai.com', [JOB]))
    need(pg.is_visible('#adminBar') and 'Admin only' in pg.inner_text('#adminBar'), 'admin bar / Admin only tag missing')
    pg.click('#signOutBtn'); pg.wait_for_timeout(500)
    need(not pg.is_visible('#adminBar'), 'studio bar still visible after sign-out')
    return errs

@check('Supplier: studio login with no supplier chosen cannot open an empty My frames')
def _(b):
    pg, errs = open_page(b, 'supplier.html', sup_seed('admin@kalai.com', [JOB]))
    btn = pg.locator('#jTabs [data-t="frames"]')
    if btn.count() and btn.is_visible():
        btn.click(); pg.wait_for_timeout(400)
        need(not pg.is_visible('#framesView'), 'empty My frames opened for the studio login')
    return errs


@check('Print shop portal: says the frame shop collects the print (not "Kalai allocates the courier")')
def _(b):
    job = dict(JOB, role='printer', stage='READY', courier='', handTo={'name': 'Rafi Frames', 'phone': '', 'address': 'Karama'})
    pg, errs = open_page(b, 'supplier.html', sup_seed('rafi@x.com', [job]))
    t = pg.inner_text('#jList')
    need('collects the print from you' in t and 'allocates the courier' not in t, 'print shop still told a courier is coming')
    return errs

# ---------------------------------------------------------------- Artist desk
@check('Artist desk: paper size taken from the artwork (was "not stated")')
def _(b):
    it = order(status='PAID', zohoPOId='po1', title='Lily Pond Steps (Watercolour on paper, 38 × 28 cm)')
    seed = {'users': ADMIN, 'session': 'admin@kalai.com', 'sellers': SELLERS, 'items': [it], 'costing': [{'enquiryId': 'e1', 'artistPriceInr': 15000}]}
    pg, errs = open_page(b, 'artist.html', seed, wait=3000)
    t = pg.inner_text('body')
    need('Paper size: not stated' not in t, 'paper size still "not stated"')
    need('38 × 28 cm' in t, 'paper size 38 × 28 cm not shown')
    return errs



@check('Send the job: frame shop and courier sent one after the other both arrive (second one was lost)')
def _(b):
    seed = {'users': ADMIN, 'session': 'admin@kalai.com', 'sellers': SELLERS, 'listings': [],
            'items': [order(status='ARTIST_SENT', artistStage='SHIPPED', artistCourier='DHL Express UAE', artistAwb='T1', deliveryEmirate='Dubai', deliveryAddress='Villa 1')],
            'costing': [{'enquiryId': 'e1'}]}
    pg, errs = open_page(b, 'admin.html#order=e1', seed, width=1500)
    pg.evaluate("localStorage.setItem('slowMs','1200')")
    pg.select_option('[data-js="framer-sid"]', 'f1'); pg.click('[data-jobsend="framer"]'); pg.wait_for_timeout(150)
    need(pg.locator('[data-jobsend="delivery"]').is_disabled(), 'courier Send was clickable while the frame shop job was still saving')
    need(pg.inner_text('[data-jobsend="delivery"]').strip() == 'Wait…', 'waiting courier button does not say Wait…')
    pg.wait_for_timeout(1600)
    pg.click('[data-jobsend="delivery"]'); pg.wait_for_timeout(1800)
    jobs = json.loads(pg.evaluate("JSON.parse(localStorage.stubdb).costing[0].supplierJobs"))
    need('framer' in jobs and 'delivery' in jobs, f'jobs saved: {list(jobs)}')
    return errs

@check('Server: saveJobs merges with a conditional write (two saves at once must not lose a job)')
def _(b):
    src = open(os.path.join(os.path.dirname(os.path.dirname(HERE)), 'amplify', 'functions', 'zoho-quote-sync', 'handler.ts')).read()
    body = src[src.index('async function saveJobs'):src.index('async function enquiryRow')]
    need('ConditionExpression' in body and 'JOBS_READ' in body and 'ConditionalCheckFailedException' in body, 'saveJobs overwrites the whole job list again')
    return []


@check('Little Artists: "Made with love · Made by a machine" pairs all load, no sideways scroll on a phone')
def _(b):
    pg, errs = open_page(b, 'index.html#little-artists', {'users': ADMIN, 'session': None, 'items': []}, wait=2500, width=390)
    pg.evaluate("document.querySelectorAll('#lp-vs img').forEach(i => i.loading = 'eager')"); pg.wait_for_timeout(2500)
    n, broken = pg.evaluate("[document.querySelectorAll('#lp-vs img').length, [...document.querySelectorAll('#lp-vs img')].filter(i => !i.naturalWidth).map(i => i.src)]")
    need(n >= 12, f'only {n} pairs'); need(not broken, f'missing pictures: {broken}')
    need(pg.evaluate('document.documentElement.scrollWidth') <= 391, 'page scrolls sideways on a phone')
    return errs


@check('Little Artists: the top picture rotates through all 14 child vs AI pairs')
def _(b):
    import re
    src = open(os.path.join(os.path.dirname(os.path.dirname(HERE)), 'index.html')).read()
    m = re.search(r"const P=\[([^\]]*)\]", src)
    n = len(re.findall(r"little-vs-ai", m.group(1))) if m else 0
    need(n >= 14, f'rotation has {n} pairs')
    return []


@check('Little Artists: pair names readable in dark mode, pictures small (5 per row on a computer)')
def _(b):
    pg, errs = open_page(b, 'index.html#little-artists', {'users': ADMIN, 'session': None, 'items': []}, wait=2500, width=1500)
    pg.emulate_media(color_scheme='dark'); pg.evaluate("document.documentElement.setAttribute('data-theme','dark')"); pg.wait_for_timeout(300)
    col = pg.evaluate("getComputedStyle(document.querySelector('#lp-vs figcaption b')).color")
    need(col == 'rgb(31, 42, 34)', f'name colour in dark mode: {col}')
    w = pg.evaluate("document.querySelector('#lp-vs figure').getBoundingClientRect().width")
    need(w <= 200, f"pair card {w:.0f}px wide")
    need(pg.evaluate("document.getElementById('lpPair').getBoundingClientRect().width") <= 441, 'top picture wider than 440px')
    return errs

@check('Little Artists: clicking a drawing in the gallery opens the order form with that drawing in the frame')
def _(b):
    pg, errs = open_page(b, 'index.html#little-artists', {'users': ADMIN, 'session': None, 'items': []}, wait=2500, width=1300)
    fig = pg.locator('#lpGallery figure[data-src]').nth(3)
    want = fig.get_attribute('data-src'); cap = fig.locator('figcaption').inner_text()
    fig.scroll_into_view_if_needed(); fig.click(); pg.wait_for_timeout(4200)
    shown = pg.evaluate("[...document.querySelectorAll('#kMount img')].map(i => i.getAttribute('src'))")
    need(shown == [want], f'frame shows {shown}, wanted {want}')
    need(cap in pg.inner_text('#kMount .kbadge'), 'badge does not name the clicked drawing')
    need(pg.evaluate("location.hash") == '#kidsOrder', 'did not go to the order form')
    top = pg.evaluate("document.getElementById('kidsOrder').getBoundingClientRect().top")
    need(abs(top) < 200, f'order form not in view (top {top:.0f})')
    return errs


INDIA_FRAMER = {'id': 'g1', 'type': 'FRAMER', 'status': 'APPROVED', 'business': 'Guddis Frames of Arts', 'country': 'UAE',
                'address': 'No. 108, Shree Complex, 73 St Johns Rd, Bengaluru 560042, India',
                'rateCard': json.dumps({'frames': {'black': {'40×50': 1900}}, 'currency': 'INR', 'from': 'India', 'basis': 'est'})}


@check('Artists & sellers: country filter shows only the India frame shops (Guddis saved as UAE by default)')
def _(b):
    sellers = [dict(s, address='Al Quoz, Dubai') if s['id'] == 'f1' else s for s in SELLERS] + [INDIA_FRAMER]
    seed = {'users': ADMIN, 'session': 'admin@kalai.com', 'listings': [], 'items': [], 'costing': [], 'sellers': sellers}
    pg, errs = open_page(b, 'admin.html#sellers', seed, wait=3000)
    pg.click('[data-mk="suppliers"]'); pg.wait_for_timeout(500)
    need(pg.locator('#mkCountry').count() == 1, 'no country filter')
    pg.select_option('#mkCountry', 'India'); pg.wait_for_timeout(500)
    body = pg.inner_text('#mkBody')
    need('Guddis' in body, 'India frame shop missing under India'); need('Rafi Frames' not in body and 'ARAMAX' not in body, 'UAE suppliers still shown under India')
    pg.select_option('#mkCountry', 'UAE'); pg.wait_for_timeout(500)
    body = pg.inner_text('#mkBody')
    need('Guddis' not in body and 'Rafi Frames' in body, 'UAE filter wrong')
    return errs


@check('Frame shops in India: prices kept in ₹ and costed in ⃃ at the exchange rate (were entered as ⃃)')
def _(b):
    seed = {'users': ADMIN, 'session': 'admin@kalai.com', 'listings': [], 'items': [], 'costing': [],
            'sellers': SELLERS + [dict(INDIA_FRAMER, id='g2', status='PROSPECT', business='Van Gogh Frames')]}
    pg, errs = open_page(b, 'admin.html#sellers', seed, wait=3000)
    v = pg.evaluate("""import('/src/ratecard.js').then(m => { m.setInrFx(0.04); const c = m.parseCard({ rateCard: JSON.stringify({ currency: 'INR', frames: { black: { '40×50': 2000 } } }) });
      return [c.frames.black['40×50'], m.frameCost(c, { style: 'black', size: '40×50' }), m.parseCard({ rateCard: '{"frames":{"black":{"40×50":79}}}' }).frames.black['40×50']]; })""")
    need(v == [80, 80, 79], f'₹2,000 at 0.04 should cost ⃃80 (AED cards unchanged): {v}')
    pg.click('[data-mk="suppliers"]'); pg.wait_for_timeout(600)
    need('₹1,900' in pg.inner_text('#mkBody'), 'prospect price not shown in ₹')
    src = open(os.path.join(os.path.dirname(os.path.dirname(HERE)), 'src', 'supplier-prospects-seed.js')).read()
    i = src.index('FRAME_SHOPS_INDIA'); m = re.search(r'"40×50": (\d+)', src[i:])
    need(m and int(m.group(1)) >= 500, f'Bangalore seed prices not in ₹ ({m and m.group(1)})')
    return errs


@check('Pricing: competitor simulation boxes 1–3 suggest a price from each UAE competitor, 4 mixes them, "Use" fills the website price')
def _(b):
    sellers = [dict(SELLERS[0]), dict(SELLERS[1], rateCard=json.dumps({'frames': {k: {'30×40': 50, '40×50': 60} for k in ['black', 'white', 'oak', 'walnut', 'gold']}, 'fixingIncluded': True}))]
    seed = {'users': ADMIN, 'session': 'admin@kalai.com', 'sellers': sellers, 'items': [], 'listings': [], 'costing': [],
            'products': [{'id': 'w1', 'title': 'Coconut Palm', 'size': '21 × 30 cm', 'medium': 'Watercolour on paper', 'imageKey': 'x.jpg', 'status': 'LIVE', 'kind': 'painting'}],
            'aprices': [{'productId': 'w1', 'artistPrice': 3000, 'currency': 'INR'}]}
    pg, errs = open_page(b, 'admin.html#pricing', seed, wait=3500)
    pg.click('[data-f="ALL"]') if pg.locator('[data-f="ALL"]').count() else None
    pg.click('[data-open="w1"]'); pg.wait_for_timeout(800)
    need(pg.locator('.pc-simbox').count() == 4, f"{pg.locator('.pc-simbox').count()} simulation boxes")
    names = pg.locator('.pc-simbox b').all_inner_texts()
    need(names[:3] == ['1. Artezaar', '2. Gallery One', '3. Art Smiley'] and names[3] == '4. Mix', f'boxes: {names}')
    # Box 1: Artezaar S ⃃650 at −10% = 585 → ⃃600 (above the cost-based price)
    pg.click('[data-sim="0"]'); pg.wait_for_timeout(200)
    need(pg.inner_text('[data-simp="black"]') == '600', f"Artezaar black {pg.inner_text('[data-simp=black]')}")
    pg.click('[data-sim="2"]'); pg.wait_for_timeout(200)
    art = int(pg.inner_text('[data-simp="black"]'))
    # Mix: lowest = Art Smiley's 400 (or the cost floor), highest = Artezaar's 600
    pg.select_option('#simRule', 'high'); pg.wait_for_timeout(200)
    need(pg.inner_text('[data-simp="black"]') == '600', 'highest rule is not Artezaar')
    pg.select_option('#simRule', 'low'); pg.wait_for_timeout(200)
    need(int(pg.inner_text('[data-simp="black"]')) == art, 'lowest rule is not Art Smiley')
    pg.select_option('#simRule', 'weighted'); pg.wait_for_timeout(200)
    need(pg.locator('#simW input').count() == 3, 'no weight boxes for the weighted rule')
    pg.click('[data-sim="0"]'); pg.wait_for_timeout(200); pg.click('#simUse'); pg.wait_for_timeout(300)
    need(pg.input_value('[data-final="black"]') == '600', f"website price box {pg.input_value('[data-final=black]')}")
    need(pg.evaluate("document.documentElement.scrollWidth") <= 1401, 'page scrolls sideways')
    return errs


@check('Little Artists: Real / AI tabs show only the child\'s half or the machine\'s half of every pair, in the same frame; a Both tab (default) shows both again')
def _(b):
    pg, errs = open_page(b, 'index.html#little-artists', {'users': ADMIN, 'session': None, 'items': []}, wait=2500, width=1300)
    rect = lambda sel: pg.evaluate(f"(() => {{ const r = document.querySelector('{sel}').getBoundingClientRect(); return [r.width, r.height, r.left]; }})()")
    box0 = rect('#lp-vs .vsbox'); clip = lambda: rect('#lp-vs .vsclip'); img = lambda: rect('#lp-vs .vsclip img')
    need(abs(clip()[0] - box0[0]) < 2, 'default does not show both halves')
    pg.click('#lp-vs [data-vs="real"]'); pg.wait_for_timeout(200)
    c, i = clip(), img()
    need(abs(rect('#lp-vs .vsbox')[1] - box0[1]) < 2, 'frame changed size')
    need(abs(c[0] - box0[0] / 2) < 2 and abs(i[2] - c[2]) < 2, 'Real tab does not show the left (child) half')
    need(not pg.locator('#lp-vs figcaption .r').first.is_visible(), '"Made by a machine" still shown under Real')
    pg.click('#lp-vs [data-vs="ai"]'); pg.wait_for_timeout(200)
    c, i = clip(), img()
    need(abs(i[2] + i[0] / 2 - c[2]) < 2, 'AI tab does not show the right half')
    need(not pg.locator('#lp-vs figcaption .hl').first.is_visible(), '"Made with love" still shown under AI')
    pg.click('#lp-vs [data-vs=""]'); pg.wait_for_timeout(200)
    need(abs(clip()[0] - box0[0]) < 2, 'Both tab does not show both pictures again (Anis, 28 Oct)')
    need(pg.get_attribute('#lp-vs [data-vs=""]', 'aria-pressed') == 'true', 'Both tab not marked as chosen')
    return errs


@check('Little Artists: clicking a Made-with-love pair opens the order form with the child\'s drawing in the frame')
def _(b):
    pg, errs = open_page(b, 'index.html#little-artists', {'users': ADMIN, 'session': None, 'items': []}, wait=2500, width=1300)
    fig = pg.locator('#lp-vs figure[data-kid]').nth(4)
    want = fig.get_attribute('data-kid'); name = fig.locator('figcaption b').inner_text()
    fig.scroll_into_view_if_needed(); fig.click(); pg.wait_for_timeout(1500)
    shown = pg.evaluate("[...document.querySelectorAll('#kMount img')].map(i => i.getAttribute('src'))")
    need(shown == [want], f'frame shows {shown}, wanted {want}')
    need(name in pg.inner_text('#kMount .kbadge'), 'badge does not name the drawing')
    need(pg.evaluate("location.hash") == '#kidsOrder', 'did not go to the order form')
    broken = pg.evaluate("Promise.all([...document.querySelectorAll('#lp-vs figure[data-kid]')].map(f => new Promise(r => { const i = new Image(); i.onload = () => r(null); i.onerror = () => r(f.dataset.kid); i.src = f.dataset.kid; }))).then(x => x.filter(Boolean))")
    need(not broken, f'missing child pictures: {broken}')
    return errs


@check('Little Artists: drawings background on the order section; on the whole page only when switched on in Settings (Anis, 28 Oct)')
def _(b):
    pg, errs = open_page(b, 'index.html#little-artists', {'users': ADMIN, 'session': None, 'items': []}, wait=2500, width=1300)
    bg = lambda sel: pg.evaluate(f"getComputedStyle(document.querySelector('{sel}')).backgroundImage")
    need('little-bg.jpg' in bg('section.kids'), 'order section has no drawings background')
    need('little-bg.jpg' not in bg('#littlePage'), 'whole page has the drawings background while the setting is off')
    ok = pg.evaluate("new Promise(r => { const i = new Image(); i.onload = () => r(i.naturalWidth); i.onerror = () => r(0); i.src = '/img/little-bg.jpg'; })")
    need(ok > 1000, 'background picture missing')
    pg2, errs2 = open_page(b, 'index.html#little-artists', {'users': ADMIN, 'session': None, 'items': [], 'site': {'id': 'site', 'littleBg': True}}, wait=2500, width=1300)
    need('little-bg.jpg' in pg2.evaluate("getComputedStyle(document.querySelector('#littlePage')).backgroundImage"), 'setting on, but the whole page has no drawings background')
    return errs + errs2


@check('Little Artists order form: "Outside the UAE? Ask for the delivery price" like on the artworks (Anis, 28 Oct)')
def _(b):
    pg, errs = open_page(b, 'index.html#kidsOrder', {'users': ADMIN, 'session': None, 'items': []}, wait=2500, width=1300)
    btn = pg.locator('#kAskShip [data-askship]')
    need(btn.count() == 1 and btn.is_visible(), 'no "Outside the UAE?" button on the Little Artists form')
    btn.click(); pg.wait_for_timeout(300)
    need(pg.locator('#kAskShip [data-asform] select[data-k="country"]').is_visible(), 'the delivery-price form does not open')
    pg.click('#kAskShip [data-assend]'); pg.wait_for_timeout(200)
    need('name and mobile' in pg.inner_text('#kAskShip [data-asok]'), 'Ask button does nothing without name/mobile')
    return errs


@check('App: every page links its own app manifest (icons load), and "Install app" appears when the phone offers it')
def _(b):
    errs = []
    seen = set()
    for page in ['index.html', 'admin.html', 'seller.html', 'artist.html', 'supplier.html', 'offers.html']:
        pg, e = open_page(b, page, {'users': ADMIN, 'session': None, 'items': []}, wait=1500, width=390)
        errs += e
        href = pg.get_attribute('link[rel="manifest"]', 'href')
        need(href, f'{page}: no app manifest')
        m = pg.evaluate(f"fetch('{href}').then(r => r.json())")
        need(m['display'] == 'standalone' and m['start_url'] and m['name'], f'{page}: manifest incomplete')
        seen.add(m['id'])
        for ic in m['icons']:
            w = pg.evaluate(f"new Promise(r => {{ const i = new Image(); i.onload = () => r(i.naturalWidth); i.onerror = () => r(0); i.src = '{ic['src']}'; }})")
            need(w == int(ic['sizes'].split('x')[0]), f"{page}: icon {ic['src']} is {w}px")
        need(pg.locator('link[rel="apple-touch-icon"]').count() == 1, f'{page}: no iPhone icon')
        pg.evaluate("(() => { const e = new Event('beforeinstallprompt'); e.prompt = () => { window.__asked = 1; }; e.userChoice = Promise.resolve({ outcome: 'dismissed' }); window.dispatchEvent(e); })()")
        pg.wait_for_timeout(200)
        need(pg.locator('#appInstall').count() == 1, f'{page}: no Install app button')
        pg.click('#appInstall'); pg.wait_for_timeout(100)
        need(pg.evaluate('window.__asked') == 1, f'{page}: Install app does not open the install prompt')
        need(pg.evaluate("document.documentElement.scrollWidth") <= 391, f'{page}: Install app button makes the page scroll sideways on a phone')
        pg.close()
    need(len(seen) == 5, f'apps not separate: {seen}')
    return errs


# ---------------------------------------------------------------- Server code guards (the Lambda isn't run here)
@check('Server: order details read through detStr (website orders store them as a map; brief was empty)')
def _(b):
    import re
    src = open(os.path.join(os.path.dirname(os.path.dirname(HERE)), 'amplify', 'functions', 'zoho-quote-sync', 'handler.ts')).read()
    bad = re.findall(r"str\(\w+, 'details'\)", src)
    need(not bad, f'{len(bad)} place(s) read details as a plain string: use detStr()')
    return []


@check('Supplier invoices: Zoho bill uses the supplier\'s own invoice number by default (Anis, 27 Oct)')
def _(b):
    root = os.path.dirname(os.path.dirname(HERE))
    src = open(os.path.join(root, 'amplify', 'functions', 'zoho-quote-sync', 'handler.ts')).read()
    num = open(os.path.join(root, 'src', 'numbers.js')).read()
    need("supInv: { prefix: '', mode: 'alpha', source: 'external'" in src, 'server default for supplier invoices is not External')
    need("k: 'supInv'" in num and "source: 'external', ext: 'Supplier types their own'" in num, 'Settings default for supplier invoices is not External')
    return []


@check('Artist desk: searching an order number finds it even under another tab (Price needed)')
def _(b):
    it = order(id='c8', ref='KA-261022-77QM', kind='COMMISSION', title='Commission: Pet portrait', status='RECEIVED', quotedPrice=None, zohoInvoiceId=None)
    seed = {'users': ADMIN, 'session': 'admin@kalai.com', 'sellers': SELLERS, 'items': [it], 'costing': []}
    pg, errs = open_page(b, 'artist.html', seed, wait=3000)
    pg.fill('#qRef', '77QM'); pg.wait_for_timeout(700)
    need('KA-261022-77QM' in pg.inner_text('#list'), 'order not found by search from the default tab')
    return errs


@check('Artist desk: a Collection order still without a price shows under Price needed (65CF sat unseen)')
def _(b):
    it = order(id='p65', ref='KA-261022-65CF', kind='PRICE', title='Plank Bridge Over the Stream', status='RECEIVED', quotedPrice=None, zohoInvoiceId=None)
    seed = {'users': ADMIN, 'session': 'admin@kalai.com', 'sellers': SELLERS, 'items': [it], 'costing': []}
    pg, errs = open_page(b, 'artist.html', seed, wait=3000)
    pg.click('[data-f="NEEDED"]'); pg.wait_for_timeout(500)
    need('KA-261022-65CF' in pg.inner_text('#list'), 'collection order without a price not under Price needed')
    need('(1)' in pg.inner_text('#cNeeded'), 'Price needed count does not include it')
    return errs


@check('Server: a Collection order without "Artwork no." finds its work by title for the artist\'s catalogue price (65CF)')
def _(b):
    src = open(os.path.join(os.path.dirname(os.path.dirname(HERE)), 'amplify', 'functions', 'zoho-quote-sync', 'handler.ts')).read()
    i = src.index('async function useCataloguePrice'); body = src[i:i + 2500]
    need('byTitle' in body and 'byTitle.length === 1' in body, 'useCataloguePrice has no single-match title fallback')
    return []


@check('Artist desk: frame shop address shown once ("Send it to" repeated Guddis\'s name and address, 65CF)')
def _(b):
    pg, errs = open_page(b, 'artist.html', {'users': ADMIN, 'session': 'admin@kalai.com', 'sellers': SELLERS, 'items': [], 'costing': []}, wait=2000)
    v = pg.evaluate("import('/src/artist.js').then(m => m.tidyAddr('No. 108, Shree Complex, 73 St Johns Rd, Bengaluru 560042, India, No. 108, Shree Complex, 73 St Johns Rd, Bengaluru 560042, I, India'))")
    need(v == 'No. 108, Shree Complex, 73 St Johns Rd, Bengaluru 560042, India', f'address: {v}')
    return errs


@check('Every admin/portal page warns when a newer version is live (stale open tabs ran old code)')
def _(b):
    root = os.path.dirname(os.path.dirname(HERE))
    miss = [f for f in ('admin', 'supplier', 'artist', 'seller') if "import './fresh.js'" not in open(os.path.join(root, 'src', f + '.js')).read()]
    need(not miss, f'no new-version banner on: {miss}')
    return []

# ---------------------------------------------------------------- Every page loads without errors
@check('All pages load without script errors')
def _(b):
    seed = {'users': ADMIN, 'session': 'admin@kalai.com', 'sellers': SELLERS, 'items': [order()], 'costing': [], 'listings': []}
    bad = []
    for p in ['index.html', 'admin.html', 'supplier.html', 'artist.html', 'seller.html']:
        pg, errs = open_page(b, p, seed, wait=2000)
        bad += [f'{p}: {e}' for e in errs]; pg.close()
    return bad

def main():
    failed = 0
    with sync_playwright() as p:
        b = p.chromium.launch()
        for name, fn in RESULTS:
            try:
                errs = fn(b) or []
                if errs: raise AssertionError('script errors: ' + ' | '.join(errs[:3]))
                print(f'  ✓ {name}')
            except Exception as ex:
                failed += 1
                print(f'  ✗ {name}\n      {ex if isinstance(ex, AssertionError) else traceback.format_exc(limit=2)}')
        b.close()
    srv.shutdown()
    print(f'\n{len(RESULTS) - failed}/{len(RESULTS)} checks passed')
    sys.exit(1 if failed else 0)

main()
