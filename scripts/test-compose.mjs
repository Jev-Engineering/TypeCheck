import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
const project = process.env.VALIDATION_PROJECT ?? `jev-guard-validation-${Date.now()}`;
assert.match(project,/^jev-guard-validation-[a-z0-9-]+$/);
const base = ['compose','--env-file','tests/compose.env','-p',project,'-f','docker-compose.yml','-f','tests/compose.validation.yml'];
const transcript = [];
mkdirSync('evidence',{recursive:true});
function run(args, options={}) {
  const r = spawnSync('docker', [...base,...args], {encoding:'utf8',maxBuffer:32*1024*1024,...options});
  transcript.push({command:args.join(' '),status:r.status,stdout:r.stdout,stderr:r.stderr});
  writeFileSync('evidence/container-validation.json',JSON.stringify({project,at:new Date().toISOString(),liveDiscord:false,transcript},null,2));
  assert.equal(r.status,0,`Failed ${args.slice(0,4).join(' ')}: ${(r.stderr??'').slice(-3000)}`);
  return r.stdout.trim();
}
const exec = (...args) => run(['exec','-T',...args]);
const drill = mode => exec('app','node','/validation/persistence-drill.mjs',mode);
let ok=false;
try {
  console.log(`Isolated Compose validation: ${project}`);
  run(['up','-d','--wait','db']);
  run(['build','app']); console.log('PASS image build and in-image unit tests');
  for(let i=0;i<2;i++) run(['run','--rm','app','node','dist/server/migrate.js']);
  console.log('PASS migrations applied twice');
  const port=run(['port','db','5432']).split(':').at(-1);
  const pg=spawnSync(process.execPath,['scripts/test-postgres.mjs'],{encoding:'utf8',env:{...process.env,ALLOW_DATABASE_TESTS:'true',TEST_DATABASE_URL:`postgresql://guard:isolated-test-only-password@127.0.0.1:${port}/guard`}});
  writeFileSync('evidence/postgres-validation.txt',(pg.stdout??'')+(pg.stderr??''));
  assert.equal(pg.status,0,'PostgreSQL assertions failed; see evidence/postgres-validation.txt');
  console.log(pg.stdout.trim());
  run(['up','-d','--wait','app']);
  const appPort=run(['port','app','3000']).split(':').at(-1);
  const url=`http://127.0.0.1:${appPort}`;
  for(const [path,status] of [['/api/ready',200],['/vendor/discord-sdk.js',200],['/api/g/900000000000000001/images',401],['/.env',404]]) {
    const res=await fetch(url+path); assert.equal(res.status,status,path); await res.arrayBuffer();
  }
  assert.equal((await fetch(url+'/api/auth/start',{method:'POST',headers:{Origin:'https://evil.invalid'}})).status,403);
  console.log('PASS health, official SDK asset, unauthenticated and origin rejection');
  console.log(drill('seed'));
  run(['stop','db']);
  assert.equal((await fetch(url+'/api/ready')).status,503);
  run(['up','-d','--wait','db']);
  run(['restart','app']); run(['up','-d','--wait','app']);
  console.log(drill('recover'));
  console.log('PASS database outage readiness, project-only restart and interrupted job recovery');
  // Quiesce the only application writer for a consistent DB/object snapshot.
  run(['stop','app']);
  exec('db','pg_dump','-U','guard','-d','guard','-Fc','-f','/tmp/guard.dump');
  // Persist archive in a separate named volume, then restore into an empty object volume.
  run(['run','--rm','--user','0','--cap-add','CHOWN','-v',`${project}_backup:/backup`,'app','chown','node:node','/backup']);
  run(['run','--rm','-v',`${project}_backup:/backup`,'app','tar','-C','/data/objects','-cf','/backup/objects.tar','.']);
  exec('db','createdb','-U','guard','guard_restore');
  exec('db','pg_restore','-U','guard','-d','guard_restore','--exit-on-error','/tmp/guard.dump');
  // New volumes default to root ownership; initialize only the dedicated restore volume.
  run(['run','--rm','--user','0','--cap-add','CHOWN','-v',`${project}_restore:/restore`,'app','chown','node:node','/restore']);
  run(['run','--rm','-v',`${project}_backup:/backup:ro`,'-v',`${project}_restore:/restore`,'app','tar','-C','/restore','-xf','/backup/objects.tar']);
  run(['run','--rm','-e','DATABASE_URL=postgresql://guard:isolated-test-only-password@db:5432/guard_restore','-e','OBJECT_DIR=/restore','-v',`${project}_restore:/restore`,'app','node','/validation/persistence-drill.mjs','restored']);
  console.log('PASS isolated database + object + encryption-key restoration');
  run(['up','-d','--wait','app']); console.log(drill('read'));
  const logs=run(['logs','--no-color','app']);
  for(const secret of ['offline-fixture-only','AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=','isolated-test-only-password']) assert.ok(!logs.includes(secret),'Secret appeared in logs');
  run(['ps']); ok=true;
} finally {
  run(['down']); // Remove only this project's containers/network; retain volumes/evidence.
  writeFileSync('evidence/container-result.json',JSON.stringify({project,at:new Date().toISOString(),passed:ok,liveDiscord:false,stopped:true},null,2));
}
