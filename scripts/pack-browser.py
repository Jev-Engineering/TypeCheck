"""Ephemeral Docker Playwright MCP client. Uses only the already-installed image."""
import json, subprocess, sys
from pathlib import Path
root=Path(__file__).resolve().parents[1]
output=root/'docs/assets/packs';output.mkdir(parents=True,exist_ok=True)
proc=subprocess.Popen(['docker','run','-i','--rm','--init','-v',str(output)+':/output','mcp/playwright'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,encoding='utf-8')
counter=0
def call(method,params):
    global counter
    counter+=1
    proc.stdin.write(json.dumps({'jsonrpc':'2.0','id':counter,'method':method,'params':params})+'\n');proc.stdin.flush()
    while True:
        line=proc.stdout.readline()
        if not line: raise RuntimeError('MCP exited')
        try: result=json.loads(line)
        except ValueError: continue
        if result.get('id')==counter:
            if 'error' in result: raise RuntimeError(result['error'])
            return result['result']
try:
    call('initialize',{'protocolVersion':'2024-11-05','capabilities':{},'clientInfo':{'name':'typecheck-pack-validation','version':'1'}})
    if len(sys.argv)==1:
        result=call('tools/list',{})
        print(json.dumps(result,indent=2))
    else:
        code=Path(sys.argv[1]).read_text(encoding='utf-8')
        result=call('tools/call',{'name':'browser_run_code_unsafe','arguments':{'code':code}})
        print(json.dumps(result,indent=2))
finally:
    proc.stdin.close();proc.wait(timeout=30)
