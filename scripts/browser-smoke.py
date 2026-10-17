"""Offline rendering of compiled UI with synthetic transport/SDK; no network, not Discord acceptance."""
import asyncio, json, re, subprocess, base64, os
from pathlib import Path
from playwright.async_api import async_playwright
root=Path(__file__).resolve().parents[1]
prefix=os.environ.get('BROWSER_EVIDENCE_PREFIX','')
async def main():
    findings=[];errors=[]
    raw=subprocess.check_output(['node','--input-type=module','-e',"import * as d from './scripts/preview-data.mjs'; console.log(JSON.stringify(d));"],cwd=root,text=True,encoding='utf-8')
    data=json.loads(raw)
    data['png']=base64.b64encode((root/'fixtures/reference.png').read_bytes()).decode()
    domain=(root/'dist/shared/domain.js').read_text(encoding='utf-8')
    domain=re.sub(r'^import .*?;\n|^export ', '', domain, flags=re.M)
    content=re.sub(r'^import .*?;\n|^export ', '', (root/'dist/shared/content.js').read_text(encoding='utf-8'), flags=re.M)
    frontend=(root/'dist/activity/src/main.js').read_text(encoding='utf-8')
    frontend=re.sub(r'^import .*?;\n','',frontend,flags=re.M)
    analytics=(root/'dist/shared/analytics.js').read_text(encoding='utf-8')
    analytics=re.sub(r'^import .*?;\n|^export ', '', analytics, flags=re.M)
    preview_costs=re.sub(r'^export ', '', (root/'scripts/preview-cost-data.mjs').read_text(encoding='utf-8'),flags=re.M)
    frontend=frontend.replace('await import(modulePath)','({ DiscordSDK: globalThis.__PreviewSDK })')
    frontend=frontend.replace("const first = links()", "const first = links()")
    mock='''(() => {const d=DATA;
      const contentDefinition=CONTENT_PRESETS[0].definition;
      d.rules.push({...d.rules[0],id:'00000000-0000-4000-8000-000000000099',name:'Synthetic content test',type:'content',referenceId:null,groupId:null,content:contentDefinition,threshold:.7,action:'timeout'});
      globalThis.__PreviewSDK=class{guildId=d.guild;async ready(){};commands={authorize:async()=>({code:'offline'}),authenticate:async()=>({})}};
      globalThis.fetch=async (input,options={})=>{const path=String(input).split('?')[0];
        const response=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
        if(path==='/api/config')return response({clientId:'100000000000000099',preview:true});
        if(path==='/api/auth/start')return response({nonce:'offline'});
        if(path==='/api/auth/exchange')return response({sessionToken:'offline',accessToken:'offline',authority:d.authority});
        if(path.endsWith('/00000000-0000-4000-8000-000000000099/test'))return response({probability:.9,predicted:true,ruleThreshold:.7,actionFloor:.9,effectiveThreshold:.9,thresholdApplies:true,meetsThreshold:true,inputTokens:120,hashComparisons:0,accounting:{attempts:1,estimatedCostMicros:null,partial:true},policyOutcome:{action:'timeout',reason:'monitoring_only'},matches:[{model:'jev-1.14.0',content:{definition:contentDefinition,status:'detected',readability:'readable',context:'solicitation',promotionProbability:.95,depictedProbability:.98,blockedReasons:[],promptVersion:'image-content-v1',signals:{credentials:.9}}}]});
        if(options.method&&options.method!=='GET')return response({error:'offline_preview_is_read_only'},403);
        const r=path.split('/').slice(4).join('/');
        if(r.startsWith('analytics/'))return response(previewCosts(r,new URL(String(input),'https://preview.invalid').searchParams));
        const map={'match-thresholds':d.settings.value.thresholds,me:d.authority,meta:d.metadata,settings:d.settings,images:d.images,groups:d.groups,rules:d.rules,grants:[],credentials:d.credential,
          dashboard:{settings:d.settings,botOnline:false,credential:d.credential,usage:{calls:0,inputTokens:0},counts:{images:3,rules:3,evaluations:0,events:2,successful:0,suppressedOrFailed:2},recent:d.events}};
        if(r in map)return response(map[r]);
        if(r.endsWith('/content'))return new Response(Uint8Array.from(atob(d.png),c=>c.charCodeAt(0)),{headers:{'Content-Type':'image/png'}});
        if(r.endsWith('/calibration'))return response([]);
        if(['events','evaluations','audit','actions'].includes(r))return response({items:r==='events'?d.events:[],nextBefore:null,totalRetained:r==='events'?2:0});
        return response({error:'preview_route_not_found'},404);
      };
    })();'''.replace('DATA',json.dumps(data)).replace('const d=',preview_costs+'\nconst d=',1)
    async with async_playwright() as p:
        browser=await p.chromium.launch(executable_path=os.environ.get('CHROMIUM_EXECUTABLE','/usr/bin/chromium'),headless=True,args=['--no-sandbox'])
        for label,w,h in [('desktop',1440,1000),('mobile',390,844)]:
            page=await browser.new_page(viewport={'width':w,'height':h},device_scale_factor=1)
            page.on('pageerror',lambda e:errors.append(str(e)))
            await page.set_content('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>'+(root/'activity/style.css').read_text(encoding='utf-8')+'</style></head><body><div id="app"></div></body></html>')
            await page.add_script_tag(content=domain+'\n'+content+'\n'+analytics+'\n'+mock+'\n'+frontend,type='module')
            await page.get_by_role('button',name='Open read-only preview').click()
            await page.get_by_role('heading',name='Recent moderation events').wait_for()
            await page.screenshot(path=str(root/'evidence'/f'{prefix}preview-{label}.png'),full_page=True)
            for title in ['Image library','Rules & tests','Cost & Usage','Activity log','Permissions','Settings','Overview']:
                await page.get_by_role('navigation').get_by_role('button',name=title,exact=True).click()
                await page.get_by_role('heading',name=title,exact=True).wait_for()
                await page.wait_for_timeout(100)
                overflow=await page.evaluate('document.documentElement.scrollWidth > window.innerWidth + 1')
                notices=await page.locator('.notice.error').all_text_contents()
                findings.append({'viewport':label,'screen':title,'horizontalOverflow':overflow,'errors':notices})
                if title=='Cost & Usage':
                    body=await page.locator('main').inner_text()
                    assert 'Estimated USD' in body and 'Estimated EUR' in body
                    assert 'Legacy' in body or 'legacy' in body
                    await page.get_by_role('button',name='Next page',exact=True).click()
                    await page.get_by_role('button',name='First page',exact=True).wait_for()
                    await page.get_by_role('button',name='First page',exact=True).click()
                    await page.get_by_role('button',name='Next page',exact=True).wait_for()
                    await page.screenshot(path=str(root/'evidence'/f'{prefix}cost-{label}.png'),full_page=True)
                    findings.append({'viewport':label,'costs':'mixed currencies, legacy coverage and pagination passed'})
                if title=='Image library' and label=='desktop':await page.screenshot(path=str(root/'evidence'/(prefix+'preview-library.png')),full_page=True)
            await page.get_by_role('navigation').get_by_role('button',name='Rules & tests',exact=True).click()
            await page.get_by_role('button',name='Create rule',exact=True).click();await page.get_by_role('dialog').wait_for()
            findings.append({'viewport':label,'dialog':'Create rule','visible':await page.get_by_role('dialog').is_visible()})
            dialog=page.get_by_role('dialog')
            threshold=dialog.get_by_label('Match score threshold',exact=True)
            preset=dialog.get_by_label(re.compile(r'^Threshold preset'))
            assert await threshold.input_value()=='0.7'
            assert await preset.input_value()=='standard'
            await preset.select_option('strict'); assert await threshold.input_value()=='0.9'
            await threshold.fill('0.812345'); assert await preset.input_value()=='custom'
            await dialog.get_by_label(re.compile(r'^Action')).select_option('timeout')
            assert 'Effective threshold 0.9' in await dialog.inner_text()
            assert 'overrides the selected rule value' in await dialog.inner_text()
            await threshold.fill('1'); assert 'Effective threshold 1' in await dialog.inner_text()
            await dialog.get_by_label('Rule name',exact=True).fill('Threshold test')
            await threshold.fill('0.49')
            await dialog.get_by_role('button',name='Save rule',exact=True).click()
            await dialog.get_by_role('alert').wait_for()
            assert '0.5 to 1.0' in await dialog.get_by_role('alert').inner_text()
            await threshold.fill('0.7'); assert await preset.input_value()=='standard'
            await dialog.get_by_label(re.compile(r'^When')).select_option('any_image')
            assert await threshold.is_disabled() and await preset.is_disabled()
            assert 'Match thresholds do not apply' in await dialog.inner_text()
            await dialog.get_by_label(re.compile(r'^When')).select_option('individual')
            assert not await threshold.is_disabled()
            await dialog.get_by_label(re.compile(r'^When')).select_option('content')
            assert await dialog.get_by_label(re.compile(r'^Matching mode')).is_disabled()
            assert not await dialog.get_by_label('Yes/no question',exact=True).is_hidden()
            await dialog.get_by_label('Find a preset',exact=True).fill('credential')
            await dialog.get_by_label(re.compile(r'^Preset category')).select_option('phishing')
            await dialog.get_by_role('button',name='Load selected template',exact=True).click()
            assert 'authentication secrets' in await dialog.get_by_label('Yes/no question',exact=True).input_value()
            await dialog.get_by_label(re.compile(r'^Context source')).select_option('posting_message')
            await dialog.get_by_label('Positive criteria',exact=True).fill('Explicit request for passwords or recovery codes.')
            assert not await dialog.get_by_label('Allow automatic enforcement after approval',exact=True).is_checked()
            assert not await page.evaluate('document.documentElement.scrollWidth > window.innerWidth + 1')
            findings.append({'viewport':label,'contentEditor':'preset search, editable criteria, explicit context, no reference and monitoring default passed'})
            await page.screenshot(path=str(root/'evidence'/f'{prefix}threshold-editor-{label}.png'),full_page=True)
            findings.append({'viewport':label,'thresholdControls':'defaults, presets, custom precision, override, validation, any-image passed'})
            await page.get_by_role('dialog').get_by_role('button',name='Close',exact=True).click()
            await page.get_by_role('button',name='Edit',exact=True).nth(1).click()
            dialog=page.get_by_role('dialog')
            assert await dialog.get_by_label('Match score threshold',exact=True).input_value()=='0.82'
            assert await dialog.get_by_label(re.compile(r'^Threshold preset')).input_value()=='custom'
            await dialog.get_by_role('button',name='Close',exact=True).click()
            findings.append({'viewport':label,'existingCustomRule':'saved 0.82 preserved and displayed as Custom'})
            await page.get_by_role('button',name='Test',exact=True).last.click()
            dialog=page.get_by_role('dialog')
            await dialog.get_by_label('Sample images',exact=True).set_input_files(str(root/'fixtures/reference.png'))
            await dialog.get_by_role('button',name='Run tests',exact=True).click()
            await dialog.get_by_text(re.compile(r'^Provider attempts: 1')).wait_for()
            body=await dialog.inner_text()
            assert 'Noul probability 0.9 / rule 0.7 / action floor 0.9 / effective 0.9 / meets threshold: true' in body
            assert 'monitoring_only' in body and 'unavailable' in body and 'readable' in body
            assert await dialog.locator('.content-sample').count()==1
            await dialog.locator('.content-result').screenshot(path=str(root/'evidence'/f'{prefix}test-result-{label}.png'))
            findings.append({'viewport':label,'contentResults':'synthetic typed result, inclusive threshold, readability, blocked enforcement, unknown cost, preview and label controls passed'})
            await page.close()
        await browser.close()
    result={'scope':'Offline compiled UI, synthetic SDK/fetch; no network or live Discord authentication','checks':findings,'pageErrors':errors,'passed':not errors and all(not c.get('horizontalOverflow') and not c.get('errors') for c in findings)}
    (root/'evidence'/(prefix+'browser-smoke.json')).write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result,indent=2))
    if not result['passed']:raise SystemExit(1)
asyncio.run(main())
