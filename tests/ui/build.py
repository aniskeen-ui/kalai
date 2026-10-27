"""Build a local copy of the site that runs in a browser with no AWS: Amplify is replaced by the stubs in tests/ui/stub
(data lives in localStorage 'stubdb'). Usage: python3 tests/ui/build.py OUT_DIR"""
import os, re, shutil, sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else '/tmp/kalai-ui')
IMPORTMAP = ('<script type="importmap">{"imports":{"aws-amplify/auth":"/stub/auth.js","aws-amplify/utils":"/stub/utils.js",'
             '"aws-amplify/data":"/stub/data.js","aws-amplify/storage":"/stub/storage.js"}}</script>\n')

shutil.rmtree(OUT, ignore_errors=True)
shutil.copytree(os.path.join(ROOT, 'src'), os.path.join(OUT, 'src'))
shutil.copytree(os.path.join(ROOT, 'tests', 'ui', 'stub'), os.path.join(OUT, 'stub'))
for name in os.listdir(os.path.join(ROOT, 'public')):
    s, d = os.path.join(ROOT, 'public', name), os.path.join(OUT, name)
    (shutil.copytree if os.path.isdir(s) else shutil.copy)(s, d)
# Amplify itself and the generated outputs file are not available locally.
with open(os.path.join(OUT, 'src', 'amplify-config.js'), 'w') as f:
    f.write('// stub\n')
for js in os.listdir(os.path.join(OUT, 'src')):
    p = os.path.join(OUT, 'src', js)
    t = open(p).read()
    t2 = re.sub(r"^import outputs from '\.\./amplify_outputs\.json';", "const outputs = { storage: { bucket_name: 'b' } };", t, flags=re.M)
    if t2 != t:
        open(p, 'w').write(t2)
for html in [h for h in os.listdir(ROOT) if h.endswith('.html')]:
    t = open(os.path.join(ROOT, html)).read()
    i = t.find('<script type="module"')
    if i >= 0:
        t = t[:i] + IMPORTMAP + t[i:]
    open(os.path.join(OUT, html), 'w').write(t)
print('built', OUT)
