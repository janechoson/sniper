"""Offline JSON-lines inference worker. Public candles only, no trading imports.
Audit hooks constrain Python file/network/process APIs, not hostile native code.
"""
import sys
import os
import json
import time
import hashlib
from pathlib import Path

# Also enforce at receiver: Windows/runtime bootstrap may add system variables.
KEEP_ENV = {'SYSTEMROOT', 'WINDIR', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
            'TEMP', 'TMP', 'KRONOS_RUNTIME', 'PYTHONNOUSERSITE', 'PYTHONDONTWRITEBYTECODE',
            'PYTHONHASHSEED', 'HF_HUB_OFFLINE', 'HF_HUB_DISABLE_TELEMETRY',
            'DO_NOT_TRACK', 'OMP_NUM_THREADS', 'MKL_NUM_THREADS'}
for key in list(os.environ):
    if key.upper() not in KEEP_ENV:
        del os.environ[key]

ROOT = Path(__file__).resolve().parent
RUNTIME = Path(os.environ['KRONOS_RUNTIME']).resolve()
PINS = json.loads((ROOT / 'pins.json').read_text())
os.environ.update(HF_HUB_OFFLINE='1', HF_HUB_DISABLE_TELEMETRY='1', DO_NOT_TRACK='1')
os.chdir(RUNTIME)
sys.path.insert(0, str(ROOT / 'vendor'))
ALLOWED = [ROOT, RUNTIME, Path(sys.base_prefix).resolve(), Path(sys.prefix).resolve()]

def audit(event, args):
    if event == 'open' and isinstance(args[0], (str, bytes)):
        target = Path(os.fsdecode(args[0])).resolve()
        if not any(target == p or p in target.parents for p in ALLOWED):
            raise PermissionError('KRONOS_FILE_OUTSIDE_ALLOWLIST')
        if target.name.lower() in ('.env', 'keypair.pem') or target.suffix.lower() in ('.pem', '.key'):
            raise PermissionError('KRONOS_SECRET_FILE_FORBIDDEN')
        mode = args[1] if len(args) > 1 else None
        flags = args[2] if len(args) > 2 else 0
        writing = (isinstance(mode, str) and any(x in mode for x in 'wax+')) or (isinstance(flags, int) and flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC))
        scratch = RUNTIME / 'tmp'
        if writing and target != scratch and scratch not in target.parents:
            raise PermissionError('KRONOS_WRITE_OUTSIDE_SCRATCH')
    if event in ('socket.connect', 'socket.bind', 'subprocess.Popen', 'os.system', 'os.exec', 'os.spawn'):
        raise PermissionError('KRONOS_OFFLINE_NO_SUBPROCESS')

sys.addaudithook(audit)
if '--isolation-probe' in sys.argv:
    import socket
    blocked = {}
    for label, action in (
        ('botEnv', lambda: open(ROOT.parents[1] / '.env')),
        ('outsideFile', lambda: open(ROOT.parents[1] / 'package.json')),
        ('writeSource', lambda: open(ROOT / 'blocked-write-probe.txt', 'w')),
        ('subprocess', lambda: os.system('echo SHOULD_NEVER_RUN')),
        ('network', lambda: socket.socket().connect(('127.0.0.1', 9))),
    ):
        try:
            action()
            blocked[label] = False
        except PermissionError:
            blocked[label] = True
    print(json.dumps({'blocked': blocked, 'envNames': sorted(os.environ)}))
    sys.exit(0)
started = time.perf_counter()
import random
import numpy as np
import pandas as pd
import torch
import psutil
from safetensors.torch import load_file
from model import Kronos, KronosTokenizer, KronosPredictor

torch.set_num_threads(PINS['threads'])
torch.set_num_interop_threads(1)
torch.use_deterministic_algorithms(True)

def load(cls, folder):
    manifest = json.loads((ROOT / 'model-files.json').read_text())
    for entry in [x for x in manifest['files'] if x['group'] == folder]:
        data = (RUNTIME / folder / entry['name']).read_bytes()
        if hashlib.sha256(data).hexdigest() != entry['sha256']:
            raise ValueError('PINNED_MODEL_FILE_HASH_MISMATCH')
    config = json.loads((RUNTIME / folder / 'config.json').read_text())
    instance = cls(**config)
    instance.load_state_dict(load_file(str(RUNTIME / folder / 'model.safetensors'), device='cpu'), strict=True)
    return instance.eval()

tokenizer = load(KronosTokenizer, 'tokenizer')
model = load(Kronos, 'model')
predictor = KronosPredictor(model, tokenizer, device='cpu', max_context=PINS['contextLimit'])
assert not model.training and not tokenizer.training
load_ms = (time.perf_counter() - started) * 1000

def forecast(request):
    if set(request) != {'candles', 'decisionAt'}:
        raise ValueError('UNEXPECTED_INPUT_FIELDS')
    rows, at = request['candles'], request['decisionAt']
    if not PINS['minimumCandles'] <= len(rows) <= PINS['contextLimit']:
        raise ValueError('CONTEXT_LENGTH')
    previous = None
    for row in rows:
        if set(row) != {'at', 'open', 'high', 'low', 'close'}:
            raise ValueError('UNEXPECTED_CANDLE_FIELDS')
        if any(not np.isfinite(v) for v in row.values()) or any(row[k] <= 0 for k in ('open', 'high', 'low', 'close')):
            raise ValueError('INVALID_CANDLE')
        if row['at'] % 60000 or row['at'] + 60000 > at or (previous is not None and row['at'] - previous != 60000):
            raise ValueError('FUTURE_PARTIAL_OR_GAPPED_CANDLE')
        if not row['low'] <= min(row['open'], row['close']) <= max(row['open'], row['close']) <= row['high']:
            raise ValueError('INVALID_OHLC')
        previous = row['at']
    scale = rows[-1]['close']
    frame = pd.DataFrame([{k: row[k] / scale for k in ('open', 'high', 'low', 'close')} for row in rows])
    # Upstream documented price-only mode disables both optional channels.
    # Never feed USD volume as token volume, or derive fabricated token units.
    x_time = pd.Series(pd.to_datetime([r['at'] for r in rows], unit='ms', utc=True))
    future = [rows[-1]['at'] + 60000 * (i + 1) for i in range(PINS['horizon'])]
    y_time = pd.Series(pd.to_datetime(future, unit='ms', utc=True))
    paths = []
    begin = time.perf_counter()
    with torch.inference_mode():
        for sample in range(PINS['samples']):
            seed = PINS['seed'] + sample
            random.seed(seed)
            np.random.seed(seed)
            torch.manual_seed(seed)
            prediction = predictor.predict(frame, x_time, y_time, PINS['horizon'], T=PINS['temperature'], top_p=PINS['topP'], sample_count=1, verbose=False)
            closes = [float(x * scale) for x in prediction['close']]
            if any(not np.isfinite(x) or x <= 0 for x in closes):
                raise ValueError('INVALID_FORECAST_PRICE')
            paths.append(closes)
    return {'version': 'KRONOS_FORECAST_V1', 'model': PINS['model'], 'tokenizer': PINS['tokenizer'],
            'commit': PINS['commit'], 'paths': paths, 'forecastAt': future,
            'inputFrom': rows[0]['at'], 'inputTo': rows[-1]['at'] + 60000,
            'latestClosedCandleAt': rows[-1]['at'] + 60000, 'decisionAt': at,
            'volumeMode': PINS['volumeMode'], 'priceScale': scale, 'seed': PINS['seed'],
            'samples': PINS['samples'], 'temperature': PINS['temperature'], 'topP': PINS['topP'],
            'eval': not model.training and not tokenizer.training, 'inferenceMode': True,
            'loadMs': load_ms, 'latencyMs': (time.perf_counter() - begin) * 1000,
            'rssBytes': psutil.Process().memory_info().rss,
            'limitations': ['Three seeded paths are not calibrated probability/confidence', 'Price-only optional channels disabled', 'No Solana meme-token training validation established']}

for line in sys.stdin:
    try:
        if len(line) > 262144:
            raise ValueError('INPUT_TOO_LARGE')
        result = forecast(json.loads(line))
        print(json.dumps({'result': result}, allow_nan=False), flush=True)
    except Exception as error:
        print(json.dumps({'error': type(error).__name__ + ':' + str(error)[:200]}), flush=True)
