import urllib.request, json
req = urllib.request.Request(
    'https://backend-tawny-six-95.vercel.app/api/cache_lookup',
    data=json.dumps({"claim_text": "The moon is blue."}).encode('utf-8'),
    headers={'Content-Type': 'application/json'}
)
try:
    res = urllib.request.urlopen(req)
    print(res.read().decode('utf-8'))
except Exception as e:
    print(e)
    if hasattr(e, 'read'):
        print(e.read().decode('utf-8'))
