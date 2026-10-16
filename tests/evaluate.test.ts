import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {PNG} from './helpers.js';
test('evaluation CLI applies action floors and second verification without granting approval', async t => {
    const dir=await mkdtemp(join(tmpdir(),'jev-evaluate-test-'));
    t.after(()=>rm(dir,{recursive:true,force:true}));
    await writeFile(join(dir,'sample.png'),PNG);
    await writeFile(join(dir,'manifest.json'),JSON.stringify([
        {id:'second-disagrees',sample:'sample.png',reference:'sample.png',mode:'exact',expected:true,threshold:0.5,action:'ban'},
        {id:'below-action-floor',sample:'sample.png',reference:'sample.png',mode:'exact',expected:false,threshold:0.5,action:'timeout'}
    ]));
    await writeFile(join(dir,'mock.mjs'),`let calls=0; globalThis.fetch=async(url,init)=>{
        if(String(url)!=='https://api.typesafe.ai/v1/systemone') throw new Error('Unexpected network request');
        calls++; const q=JSON.parse(await init.body.get('request').text());
        const second=q.questions.match.instructions.startsWith('Recheck conservatively');
        return Response.json({model:q.model,answers:{match:{type:'noul',noul:second?0.01:calls===1?1:0.89}},usage:{input_tokens:1}});
    };`);
    await promisify(execFile)(process.execPath,['--import',pathToFileURL(join(dir,'mock.mjs')).href,fileURLToPath(new URL('../server/evaluate-cli.js',import.meta.url)),join(dir,'manifest.json')],{cwd:dir,env:{...process.env,TYPESAFE_EVAL_KEY:'offline-evaluation-fixture'}});
    const result=JSON.parse(await readFile(join(dir,'evaluation-results.json'),'utf8'));
    assert.equal(result.attempts,3);
    assert.equal(result.usageAttempts.length,3);
    assert.equal(result.usageAttempts.filter((a: any)=>a.verification).length,1);
    assert.ok(result.usageAttempts.every((a: any)=>a.inputTokens===1 && a.costMicros===null));
    assert.match(result.costLabel,/not a provider invoice/);
    assert.equal(result.results[0].secondProbability,0.01);
    assert.equal(result.results[0].predicted,false);
    assert.equal(result.results[1].predicted,false);
    assert.equal(result.results[1].threshold,0.9);
    assert.equal(result.results[1].secondProbability,null);
    assert.equal(result.approvalGranted,false);
    assert.equal(result.productionAccuracyAccepted,false);
    assert.match(result.manifestSha256,/^[a-f0-9]{64}$/);
});


test('evaluation CLI preserves earlier usage on failure and uses optional exact pricing offline', async t=>{
    const dir=await mkdtemp(join(tmpdir(),'jev-cost-cli-'));t.after(()=>rm(dir,{recursive:true,force:true}));
    await writeFile(join(dir,'sample.png'),PNG);
    await writeFile(join(dir,'manifest.json'),JSON.stringify([{id:'partial',sample:'sample.png',reference:'sample.png',mode:'exact',expected:true,threshold:0.5,secondVerification:true}]));
    await writeFile(join(dir,'mock.mjs'),`let n=0;globalThis.fetch=async()=>++n===1?Response.json({model:'jev-1.14.0',answers:{match:{type:'noul',noul:1}},usage:{input_tokens:1}}):Response.json({usage:{input_tokens:2}},{status:401});`);
    await assert.rejects(promisify(execFile)(process.execPath,['--import',pathToFileURL(join(dir,'mock.mjs')).href,fileURLToPath(new URL('../server/evaluate-cli.js',import.meta.url)),join(dir,'manifest.json')],{cwd:dir,env:{...process.env,TYPESAFE_EVAL_KEY:'offline-only-key',JEV_EVAL_PRICING:JSON.stringify({model:'jev-1.14.0',revision:0,currency:'USD',perMillion:'0.5',effectiveAt:'2020-01-01T00:00:00.000Z',note:'Synthetic test only'})}}));
    const r=JSON.parse(await readFile(join(dir,'evaluation-results.json'),'utf8'));
    assert.equal(r.failure,'jev_authentication_failed');assert.deepEqual(r.usageAttempts.map((a:any)=>a.costMicros),['1','1']);assert.deepEqual(r.usageAttempts.map((a:any)=>a.outcome),['success','failure']);
});
