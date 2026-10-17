"""Ephemeral Playwright MCP. Existing local image only; output contains synthetic UI evidence."""
import json
import subprocess
from pathlib import Path

root = Path(__file__).resolve().parents[1]
output = root / 'evidence' / 'consent49'
output.mkdir(parents=True, exist_ok=True)
proc = subprocess.Popen(['docker', 'run', '-i', '--rm', '--init', '-v', str(output) + ':/output', 'mcp/playwright'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, encoding='utf-8')
counter = 0

def call(method, params):
    global counter
    counter += 1
    proc.stdin.write(json.dumps({'jsonrpc': '2.0', 'id': counter, 'method': method, 'params': params}) + '\n')
    proc.stdin.flush()
    while True:
        line = proc.stdout.readline()
        if not line:
            raise RuntimeError('MCP exited')
        try:
            result = json.loads(line)
        except ValueError:
            continue
        if result.get('id') == counter:
            if 'error' in result:
                raise RuntimeError(result['error'])
            return result['result']

try:
    call('initialize', {'protocolVersion': '2024-11-05', 'capabilities': {}, 'clientInfo': {'name': 'typecheck-consent49', 'version': '1'}})
    result = call('tools/call', {'name': 'browser_run_code_unsafe', 'arguments': {'code': (root / 'scripts' / 'consent-browser-workflow.js').read_text(encoding='utf-8')}})
    (output / 'browser.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
    print(json.dumps(result, indent=2))
    if result.get('isError'):
        raise SystemExit(1)
finally:
    proc.stdin.close()
    proc.wait(timeout=30)
