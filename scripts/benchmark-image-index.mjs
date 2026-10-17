// Build a dataset grouping index with the unchanged production normalizer.
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {normalize,NORMALIZATION_HASH_VERSION} from '../dist/server/images.js';
const [input,output]=process.argv.slice(2);
if(!input||!output)throw Error('usage_image_index_input_json_output_json');
const cases=JSON.parse(readFileSync(input,'utf8')),results=[];
for(const c of cases){
  try{const bytes=readFileSync(c.file),image=await normalize(bytes);results.push({...c,sourceSha256:createHash('sha256').update(bytes).digest('hex'),normalizedSha256:image.sha256});}
  catch{results.push({...c,error:'normalization_rejected'});}
}
writeFileSync(output,JSON.stringify({hashVersion:NORMALIZATION_HASH_VERSION,results}));
console.log(JSON.stringify({indexed:results.length,rejected:results.filter(r=>r.error).length}));
