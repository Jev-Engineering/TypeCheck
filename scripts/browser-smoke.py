"""Offline rendering of compiled UI with synthetic transport/SDK; no network, not Discord acceptance."""
import asyncio, json, re, subprocess, base64, os
from pathlib import Path
from playwright.async_api import async_playwright
root=Path(__file__).resolve().parents[1]
async def main():
    findings=[];errors=[]
    raw=subprocess.check_output(['node','--input-type=module','-e',"import * as d from './scripts/preview-data.mjs'; console.log(JSON.stringify(d));"],cwd=root,text=True)
    data=json.loads(raw)
    data['png']=base64.b64encode((root/'fixtures/reference.png').read_bytes()).decode()
    domain=(root/'dist/shared/domain.js').read_text()
    domain=re.sub(r'^export ', '', domain, flags=re.M)
    frontend=(root/'dist/activity/src/main.js').read_text()
    frontend=re.sub(r'^import .*?;\n','',frontend,count=1)
    frontend=frontend.replace('await import(modulePath)','({ DiscordSDK: globalThis.__PreviewSDK })')
    frontend=frontend.replace("const first = links()", "const first = links()")
    mock='''(() => {const d=DATA;
      globalThis.__PreviewSDK=class{guildId=d.guild;async ready(){};commands={authorize:async()=>({code:'offline'}),authenticate:async()=>({})}};
      globalThis.fetch=async (input,options={})=>{const path=String(input).split('?')[0];
        const response=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
        if(path==='/api/config')return response({clientId:'100000000000000099',preview:true});
        if(path==='/api/auth/start')return response({nonce:'offline'});
        if(path==='/api/auth/exchange')return response({sessionToken:'offline',accessToken:'offline',authority:d.authority});
        if(options.method&&options.method!=='GET')return response({error:'offline_preview_is_read_only'},403);
        const r=path.split('/').slice(4).join('/');
        const map={me:d.authority,meta:d.metadata,settings:d.settings,images:d.images,groups:d.groups,rules:d.rules,grants:[],credentials:d.credential,
          dashboard:{settings:d.settings,botOnline:false,credential:d.credential,usage:{calls:0,inputTokens:0},counts:{images:3,rules:3,evaluations:0,events:2,successful:0,suppressedOrFailed:2},recent:d.events}};
        if(r in map)return response(map[r]);
        if(r.endsWith('/content'))return new Response(Uint8Array.from(atob(d.png),c=>c.charCodeAt(0)),{headers:{'Content-Type':'image/png'}});
        if(r.endsWith('/calibration'))return response([]);
        if(['events','evaluations','audit','actions'].includes(r))return response({items:r==='events'?d.events:[],nextBefore:null,totalRetained:r==='events'?2:0});
        return response({error:'preview_route_not_found'},404);
      };
    })();'''.replace('DATA',json.dumps(data))
    async with async_playwright() as p:
        browser=await p.chromium.launch(executable_path=os.environ.get('CHROMIUM_EXECUTABLE','/usr/bin/chromium'),headless=True,args=['--no-sandbox'])
        for label,w,h in [('desktop',1440,1000),('mobile',390,844)]:
            page=await browser.new_page(viewport={'width':w,'height':h},device_scale_factor=1)
            page.on('pageerror',lambda e:errors.append(str(e)))
            await page.set_content('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>'+(root/'activity/style.css').read_text()+'</style></head><body><div id="app"></div></body></html>')
            await page.add_script_tag(content=domain+'\n'+mock+'\n'+frontend,type='module')
            await page.get_by_role('button',name='Open read-only preview').click()
            await page.get_by_role('heading',name='Recent moderation events').wait_for()
            await page.screenshot(path=str(root/'evidence'/f'preview-{label}.png'),full_page=True)
            for title in ['Image library','Rules & tests','Activity log','Permissions','Settings','Overview']:
                await page.get_by_role('navigation').get_by_role('button',name=title,exact=True).click()
                await page.get_by_role('heading',name=title,exact=True).wait_for()
                await page.wait_for_timeout(100)
                overflow=await page.evaluate('document.documentElement.scrollWidth > window.innerWidth + 1')
                notices=await page.locator('.notice.error').all_text_contents()
                findings.append({'viewport':label,'screen':title,'horizontalOverflow':overflow,'errors':notices})
                if title=='Image library' and label=='desktop':await page.screenshot(path=str(root/'evidence'/'preview-library.png'),full_page=True)
            await page.get_by_role('navigation').get_by_role('button',name='Rules & tests',exact=True).click()
            await page.get_by_role('button',name='Create rule',exact=True).click();await page.get_by_role('dialog').wait_for()
            findings.append({'viewport':label,'dialog':'Create rule','visible':await page.get_by_role('dialog').is_visible()})
            await page.get_by_role('dialog').get_by_role('button',name='Close',exact=True).click()
            await page.close()
        await browser.close()
    result={'scope':'Offline compiled UI, synthetic SDK/fetch; no network or live Discord authentication','checks':findings,'pageErrors':errors,'passed':not errors and all(not c.get('horizontalOverflow') and not c.get('errors') for c in findings)}
    (root/'evidence'/'browser-smoke.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result,indent=2))
    if not result['passed']:raise SystemExit(1)
asyncio.run(main())
