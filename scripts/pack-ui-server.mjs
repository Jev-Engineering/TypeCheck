/** Offline integration harness: real Activity + HTTP handlers + isolated in-memory store.
 * Only OAuth/Discord and model transport are faked. No production credentials or network calls.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fixture,G,G2,ADMIN,BOT,CHANNEL,ROLE } from '../dist/tests/helpers.js';
import { createHttp } from '../dist/server/http.js';
const cleanups=[],f=await fixture({after:fn=>cleanups.push(fn)}),root=process.cwd(),port=Number(process.env.PACK_UI_PORT??4181),origin='http://localhost:'+port;
const configured=await f.store.getSettings(G);
await f.store.putSettings(G,{...configured.value,channels:[CHANNEL],exemptRoles:[ROLE],logChannel:CHANNEL},configured.revision);
f.discord.memberInfo=async(guild,user)=>({guildId:guild,userId:user,owner:false,administrator:user===ADMIN,roles:[]});
const actual=createHttp(f.services,{port:0,production:false,publicOrigin:origin,clientId:G,clientSecret:'offline-only',botToken:'offline-only',databaseUrl:'unused',masterKey:'unused',objectDir:'unused',model:'jev-1.14.0',apiOnly:true},root);
await new Promise(r=>actual.listen(0,'127.0.0.1',r));const target='http://127.0.0.1:'+actual.address().port;
const proxy=createServer(async(req,res)=>{
    try {
        const path=new URL(req.url,origin).pathname.replace(/^\/r\/[^/]+/,'');
        if(path==='/vendor/discord-sdk.js') {res.setHeader('Content-Type','text/javascript');res.end(`export class DiscordSDK {guildId=new URLSearchParams(location.search).get('fresh')==='1'?'${G2}':'${G}';async ready(){};commands={authorize:async()=>({code:'admin-code'}),authenticate:async()=>({})};}`);return;}
        if(path==='/activity/src/main.js') {res.setHeader('Content-Type','text/javascript');res.end((await readFile('dist/activity/src/main.js','utf8')).replaceAll('OFFLINE, READ-ONLY PREVIEW','OFFLINE INTEGRATION TEST').replaceAll('sample data only. No Discord or Jev requests are performed.','Real UI and HTTP handlers. Writes use isolated temporary memory. Discord and model transport are faked.').replaceAll('Open read-only preview','Open offline integration test'));return;}
        const body=[];for await(const part of req)body.push(part);
        const response=await fetch(target+req.url,{method:req.method,headers:{...req.headers,host:'localhost:'+port,origin},...(body.length?{body:Buffer.concat(body)}:{})});
        res.statusCode=response.status;for(const [k,v] of response.headers)if(!['content-length','transfer-encoding','content-encoding'].includes(k))res.setHeader(k,v);
        const bytes=Buffer.from(await response.arrayBuffer());if(path==='/api/config'){const config=JSON.parse(bytes);config.preview=true;res.end(JSON.stringify(config));}else res.end(bytes);
    } catch(e) {res.statusCode=500;res.end(JSON.stringify({error:String(e)}));}
});
proxy.listen(port,'0.0.0.0',()=>console.log('Offline pack integration UI: '+origin+' (configured) or ?fresh=1 (first-login seeding)'));
async function stop(){proxy.close();actual.close();for(const fn of cleanups)await fn();process.exit();}process.on('SIGTERM',stop);process.on('SIGINT',stop);
