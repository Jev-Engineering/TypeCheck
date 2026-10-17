// Only containers created here are stopped/removed. Never uses production .env.
import { execFileSync,spawnSync } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
const docker=(...args)=>execFileSync('docker',args,{encoding:'utf8'}).trim();
for(const kind of ['postgres','mysql']) {
    const name='typecheck-packs-'+kind+'-'+Date.now(),pg=kind==='postgres';
    const args=pg?['-e','POSTGRES_PASSWORD=pack-test-only','-e','POSTGRES_DB=pack_test']:['-e','MYSQL_ROOT_PASSWORD=pack-test-only','-e','MYSQL_DATABASE=pack_test'];
    docker('run','-d','--name',name,'-p','127.0.0.1::'+(pg?'5432':'3306'),...args,pg?'postgres:16':'mysql:8.0');
    try {
        let ready=false;
        for(let n=0;n<90;n++){try{docker('exec',name,...(pg?['pg_isready','-U','postgres']:['mysql','-h127.0.0.1','-uroot','-ppack-test-only','-e','SELECT 1']));ready=true;break;}catch{}await setTimeout(1000);}
        if(!ready)throw Error(name+' not ready');
        const port=JSON.parse(docker('inspect',name))[0].NetworkSettings.Ports[pg?'5432/tcp':'3306/tcp'][0].HostPort;
        const url=(pg?'postgresql://postgres':'mysql://root')+':pack-test-only@127.0.0.1:'+port+'/pack_test';
        const env={...process.env,TEST_DATABASE_URL:url,ALLOW_DATABASE_TESTS:'true'};
        for(const script of ['scripts/test-pack-persistence.mjs',pg?'scripts/test-postgres.mjs':'scripts/test-mysql.mjs']) {
            const result=spawnSync(process.execPath,[script],{env,stdio:'inherit'});if(result.status!==0)throw Error(script+' failed');
        }
    } finally {docker('rm','-f',name);}
}
