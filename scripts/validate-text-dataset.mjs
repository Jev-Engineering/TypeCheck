import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {TEXT_STARTERS} from '../dist/shared/text-starters.js';
const bytes=readFileSync('fixtures/text/dataset.json'),d=JSON.parse(bytes);
assert.equal(d.version,1);assert.equal(d.cases.length,70);assert.equal(new Set(d.cases.map(c=>c.id)).size,70);
const seen=new Set();for(const c of d.cases){assert.ok(TEXT_STARTERS.some(s=>s.id===c.starter));assert.ok(['positive','negative','ambiguous'].includes(c.expected));assert.ok(['tuning','held_out'].includes(c.split));assert.equal(c.synthetic,true);assert.ok(c.text.length<=4000);assert.ok(!seen.has(c.text),'duplicate content across splits');seen.add(c.text);}
console.log(JSON.stringify({cases:d.cases.length,tuning:d.cases.filter(c=>c.split==='tuning').length,heldOut:d.cases.filter(c=>c.split==='held_out').length,sha256:createHash('sha256').update(bytes).digest('hex'),paidCalls:0,accuracy:'not measured'}));
