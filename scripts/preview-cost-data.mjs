/** Synthetic-only analytics preview. Rates below are invented fixtures, never defaults. */
const today=new Date().toISOString().slice(0,10);
const rate={model:'jev-1.14.0',revision:1,currency:'USD',perMillion:'2.500000',effectiveAt:'2026-01-01T00:00:00.000Z',note:'INVENTED OFFLINE FIXTURE — not provider pricing'};
export const previewRates=[rate];
const attempts=Array.from({length:53},(_,i)=>({id:`00000000-0000-4000-8000-${String(i).padStart(12,'0')}`,correlationId:'00000000-0000-4000-8000-000000000000',guildId:'synthetic',model:i%7===0?'jev-unpriced':'jev-1.14.0',purpose:['moderation','rule_test','credential_validation'][i%3],mode:'exact',verification:i%4===0,retry:i%3,startedAt:`${today}T01:${String(i).padStart(2,'0')}:00.000Z`,completedAt:i%5===0?null:`${today}T02:00:00.000Z`,outcome:['success','failure','uncertain','success','dispatching'][i%5],error:i%5===1?'jev_http_503':null,inputTokens:i%5===0?null:1200,rate:i%7===0?null:{...rate,currency:i%3===0?'EUR':'USD'},costMicros:i%7===0||i%5===0?null:'3000'}));
export function previewCosts(route,params){
 if(route==='analytics/pricing')return previewRates;
 const limit=Number(params.get('limit')??50),before=params.get('before');
 if(route==='analytics/attempts') {const all=attempts.filter(a=>!before||a.startedAt<before).sort((a,b)=>b.startedAt.localeCompare(a.startedAt)),items=all.slice(0,limit),last=items.at(-1);return {items,next:all.length>limit?{before:last.startedAt,beforeId:last.id}:null};}
 const group=route==='analytics/daily'?'day':route==='analytics/breakdown'?params.get('group'):'summary',map=new Map();
 for(const a of attempts){const key=group==='day'?today:group==='summary'?'all':String(a[group]),currency=a.rate?.currency??null,k=key+currency;let b=map.get(k);if(!b){b={key,currency,attempts:0,successes:0,failures:0,pending:0,uncertain:0,dispatched:0,unknownUsage:0,priced:0,covered:0,inputTokens:'0',costMicros:'0'};map.set(k,b);}b.attempts++;b.successes+=Number(a.outcome==='success');b.failures+=Number(a.outcome==='failure');b.pending+=Number(a.outcome==='dispatching');b.uncertain+=Number(a.outcome==='uncertain');b.dispatched++;b.unknownUsage+=Number(a.inputTokens===null);b.priced+=Number(!!a.rate);b.covered+=Number(a.costMicros!==null);b.inputTokens=String(Number(b.inputTokens)+(a.inputTokens??0));b.costMicros=String(Number(b.costMicros)+Number(a.costMicros??0));}
 return {partial:true,buckets:[...map.values()],trackingStart:today+'T00:00:00.000Z',legacy:{calls:'12',inputTokens:'8400'},start:today,end:new Date(Date.now()+86400000).toISOString().slice(0,10)};
}
