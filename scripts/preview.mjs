import { csvCell } from '../dist/server/security.js';
import { previewCosts } from './preview-cost-data.mjs';
/** Isolated local UI preview. Never imported by the production server. */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SETTINGS, CAPABILITIES } from '../dist/shared/domain.js';
const root=fileURLToPath(new URL('..',import.meta.url));
import {guild,user,authority,metadata,settings,groups,images,rules,events,credential} from './preview-data.mjs';
const sdk=`export class DiscordSDK {guildId='${guild}';async ready(){};commands={authorize:async()=>({code:'offline-preview-code'}),authenticate:async()=>({user:{id:'${user}'}})};}`;
const files={'/':'activity/index.html','/index.html':'activity/index.html','/style.css':'activity/style.css','/activity/src/main.js':'dist/activity/src/main.js','/activity/src/connection.js':'dist/activity/src/connection.js','/shared/analytics.js':'dist/shared/analytics.js','/shared/content.js':'dist/shared/content.js','/shared/domain.js':'dist/shared/domain.js','/fonts/schibsted-grotesk-400.woff2':'activity/fonts/schibsted-grotesk-400.woff2','/fonts/schibsted-grotesk-500.woff2':'activity/fonts/schibsted-grotesk-500.woff2','/fonts/vt323-400.woff2':'activity/fonts/vt323-400.woff2','/fonts/jetbrains-mono-400.woff2':'activity/fonts/jetbrains-mono-400.woff2'};
const server=createServer(async(req,res)=>{
  const path=new URL(req.url,'http://localhost').pathname;
  const send=(status,value,type='application/json')=>{res.writeHead(status,{'Content-Type':type,'Cache-Control':'no-store','X-Preview-Only':'true'});res.end(type.startsWith('application/json')?JSON.stringify(value):value);};
  try {
    if(path==='/vendor/discord-sdk.js')return send(200,sdk,'text/javascript');
    if(files[path])return send(200,await readFile(resolve(root,files[path])),path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':path.endsWith('.woff2')?'font/woff2':'text/html');
    if(path==='/api/config')return send(200,{clientId:'100000000000000099',preview:true});
    if(path==='/api/auth/start')return send(200,{nonce:'offline-preview-nonce'});
    if(path==='/api/auth/exchange')return send(200,{sessionToken:'offline-preview-session',accessToken:'offline-preview-access',authority,expiresIn:900});
    if(req.method!=='GET')return send(403,{error:'offline_preview_is_read_only'});
    if(!path.startsWith(`/api/g/${guild}/`))return send(404,{error:'preview_route_not_found'});
    const route=path.slice(`/api/g/${guild}/`.length);
    if(route==='analytics/export'){const page=previewCosts('analytics/attempts',new URL(req.url,'http://localhost').searchParams);return send(200,[['id','model','outcome','reportedInputTokens','estimatedCostMicros'],...page.items.map(a=>[a.id,a.model,a.outcome,a.inputTokens??'Usage unknown',a.costMicros??'Estimate unavailable'])].map(row=>row.map(csvCell).join(',')).join('\r\n'),'text/csv');}
    if(route.startsWith('analytics/')) return send(200,previewCosts(route,new URL(req.url,'http://localhost').searchParams));
    if(route==='me')return send(200,authority);
    if(route==='meta')return send(200,metadata);
    if(route==='match-thresholds')return send(200,settings.value.thresholds);
    if(route==='settings')return send(200,settings);
    if(route==='credentials')return send(200,credential);
    if(route==='dashboard')return send(200,{settings,botOnline:false,credential,usage:{calls:0,inputTokens:0,day:'2026-10-15'},counts:{images:3,rules:3,evaluations:0,events:2,successful:0,suppressedOrFailed:2},recent:events});
    if(route==='images')return send(200,images);
    if(route==='groups')return send(200,groups);
    if(route==='rules')return send(200,rules);
    if(route==='grants')return send(200,[]);
    if(route.endsWith('/content'))return send(200,await readFile(resolve(root,'fixtures/reference.png')),'image/png');
    if(route.endsWith('/calibration'))return send(200,[]);
    if(['events','evaluations','audit','actions'].includes(route))return send(200,{items:route==='events'?events:[],nextBefore:null,totalRetained:route==='events'?2:0});
    return send(404,{error:'preview_route_not_found'});
  }catch{send(500,{error:'preview_asset_missing_run_compile'});}
});
server.listen(Number(process.env.PREVIEW_PORT??4173),'127.0.0.1',()=>console.log('Read-only preview: http://127.0.0.1:4173 — synthetic data, not Discord authentication.'));
