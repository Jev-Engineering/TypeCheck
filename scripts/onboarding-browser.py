"""Actual compiled UI + isolated HTTP/MemoryStore + fake Discord/Jev. Not live acceptance."""
import asyncio, json, os
from pathlib import Path
from playwright.async_api import async_playwright
root=Path(__file__).resolve().parents[1]
origin=os.environ.get('ONBOARDING_TEST_ORIGIN','http://127.0.0.1:4188')
guild='100000000000000001'
async def login(page):
    await page.goto(origin+'/setup')
    await page.get_by_label('Discord server ID').fill(guild)
    # The authorize navigation is intercepted, but state/cookies/exchange/bootstrap use real app code.
    async def authorize(route):
        from urllib.parse import urlparse,parse_qs
        state=parse_qs(urlparse(route.request.url).query)['state'][0]
        await route.fulfill(status=302,headers={'Location':origin+'/api/auth/browser/callback?code=admin-code&state='+state})
    await page.route('https://discord.com/oauth2/authorize?**',authorize)
    await page.get_by_role('button',name='Sign in with Discord',exact=True).click()
    await page.get_by_role('heading',name='Agent setup',exact=True).wait_for()
async def main():
    results=[]
    async with async_playwright() as p:
        browser=await p.chromium.launch()
        for label,width,height in [('desktop',1440,1000),('mobile',390,844)]:
            context=await browser.new_context(viewport={'width':width,'height':height})
            page=await context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
            await login(page)
            # Permanent visible labeling: screenshots never imply real Discord/provider acceptance.
            await page.evaluate("""() => {const b=document.createElement('p');b.textContent='OFFLINE SYNTHETIC DEMO — fake Discord/Jev; not live acceptance';b.style='background:#ffedb3;color:#191919;padding:14px;font-weight:bold';document.body.prepend(b)}""")
            native=await page.evaluate("({documentAPI:typeof document.modelContext?.registerTool,navigatorAPI:typeof navigator.modelContext?.registerTool})")
            await page.get_by_text('WebMCP unavailable or blocked.',exact=False).wait_for()
            await page.screenshot(path=str(root/'evidence'/f'issue44-fallback-{label}.png'),full_page=True)
            await page.get_by_label('Scam and phishing review',exact=False).check()
            await page.get_by_label('Add monitored channel IDs',exact=False).fill('100000000000000021')
            await page.get_by_label('Log channel ID',exact=False).fill('100000000000000021')
            await page.screenshot(path=str(root/'evidence'/f'issue44-starters-{label}.png'),full_page=True)
            await page.get_by_role('button',name='Preview configuration',exact=True).click()
            await page.get_by_role('heading',name='Proposed configuration',exact=True).wait_for()
            await page.screenshot(path=str(root/'evidence'/f'issue44-plan-{label}.png'),full_page=True)
            await page.get_by_text('I reviewed this exact plan',exact=False).click()
            await page.get_by_role('button',name='Accept reviewed plan',exact=True).click()
            await page.get_by_role('button',name='Apply accepted plan',exact=True).click()
            await page.get_by_role('heading',name='Accepted result — enforcement off',exact=True).wait_for()
            assert not await page.evaluate('document.documentElement.scrollWidth > window.innerWidth+1')
            await page.screenshot(path=str(root/'evidence'/f'issue44-result-{label}.png'),full_page=True)
            assert not errors,errors
            results.append({'viewport':label,'browser':browser.version,'nativeWebMCP':native,'flow':'synthetic OAuth redirect through real state/cookie/session endpoints; manual starter/plan/accept/apply/receipt; no overflow','errors':errors})
            await context.close()
        # Explicit contract double: proves app tool invocation/lifecycle, not browser-agent support.
        context=await browser.new_context();page=await context.new_page()
        await page.add_init_script("""Object.defineProperty(document,'modelContext',{value:{registerTool:async(tool,{signal})=>{(window.__tools??=new Map()).set(tool.name,tool);signal.addEventListener('abort',()=>window.__tools.delete(tool.name));}}});""")
        await login(page)
        await page.wait_for_function('window.__tools?.size === 8')
        reply=json.loads(await page.evaluate("window.__tools.get('typecheck_context').execute({})"))
        assert reply['guildId']==guild
        await page.get_by_role('button',name='Log out / reconnect',exact=True).click()
        assert await page.evaluate('window.__tools.size')==0
        results.append({'contractDouble':'eight registered tools; structured context invocation; logout removes tools. Synthetic registry, not native agent discovery.'})
        await context.close();await browser.close()
        if os.environ.get('ONBOARDING_NATIVE_CHROME')=='1':
            # Author-provided in-page agent via native discovery/invocation. No registry polyfill.
            browser=await p.chromium.launch(channel='chrome',args=['--enable-features=WebMCP'])
            context=await browser.new_context();page=await context.new_page();await login(page)
            await page.wait_for_function("document.modelContext?.getTools().then(t=>t.filter(x=>x.name.startsWith('typecheck_')).length===8)")
            names=await page.evaluate("document.modelContext.getTools().then(t=>t.map(x=>x.name))")
            async def invoke(name,input={}):
                return await page.evaluate("""async ({name,input})=>{const tool=(await document.modelContext.getTools()).find(t=>t.name===name);return document.modelContext.executeTool(tool,input)}""",{'name':name,'input':input})
            reply=json.loads(await invoke('typecheck_context'));assert reply['guildId']==guild
            planned=json.loads(await invoke('typecheck_plan',{'presets':['community'],'channels':['100000000000000021'],'excludedChannels':[],'exemptRoles':[],'logChannel':'100000000000000021','customizations':{}}))
            ref={'planId':planned['id'],'digest':planned['digest']}
            refused=False
            try: await invoke('typecheck_apply_plan',ref)
            except Exception: refused=True
            assert refused,'native agent must not apply unaccepted plan'
            await page.get_by_text('I reviewed this exact plan',exact=False).click()
            await page.get_by_role('button',name='Accept reviewed plan',exact=True).click()
            applied=json.loads(await invoke('typecheck_apply_plan',ref));assert applied['receipt']['enforcement'] is False
            recovered=json.loads(await invoke('typecheck_inspect_plan',ref));assert recovered['receipt']==applied['receipt']
            # Revocation is delivered only to the isolated synthetic harness, never production.
            await page.request.post(origin+'/__synthetic/revoke')
            revoked=False
            try: await invoke('typecheck_context')
            except Exception: revoked=True
            assert revoked
            assert await page.evaluate("document.modelContext.getTools().then(t=>t.filter(x=>x.name.startsWith('typecheck_')).length)")==0
            await page.get_by_role('button',name='Log out / reconnect',exact=True).click()
            assert await page.evaluate("document.modelContext.getTools().then(t=>t.filter(x=>x.name.startsWith('typecheck_')).length)")==0
            results.append({'nativeChrome':browser.version,'flags':['--enable-features=WebMCP'],'agent':'in-page agent using native document.modelContext.getTools/executeTool; no polyfill','tools':names,'verified':'context discovery/invocation; preview; refused unaccepted apply; human UI acceptance; application; receipt; live authority revocation rejects callback and aborts registry; logout cleanup','limits':'Fake Discord and provider, top-level browser only. Does not verify built-in browser agents or Discord embedding.'})
            await context.close();await browser.close()
    report={'scope':'Offline compiled UI, real isolated HTTP service and in-memory transactions; synthetic Discord/provider/registry. Discord embedding and real OAuth/provider unverified; native in-page agent evidence is scoped per result.','results':results}
    (root/'evidence'/'issue44-browser.json').write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps(report,indent=2))
asyncio.run(main())

