// Isolated synthetic harness only. Never imported by server/main.ts; no Gateway/controller.
import {fixture,G} from '../dist/tests/helpers.js';
import {createHttp} from '../dist/server/http.js';
const cleanups=[];
const f=await fixture({after:fn=>cleanups.push(fn)});
const port=Number(process.env.ONBOARDING_TEST_PORT??4188),origin=`http://127.0.0.1:${port}`;
const server=createHttp(f.services,{port,production:false,publicOrigin:origin,clientId:G,clientSecret:'synthetic-only',botToken:'synthetic-only',databaseUrl:'unused',masterKey:'unused',objectDir:'unused',model:'jev-1.14.0',apiOnly:true});
// Harness-only authority control for browser lifecycle testing. No production import.
const handler=server.listeners('request')[0];server.removeAllListeners('request');
server.on('request',(req,res)=>{
    if(req.url==='/__synthetic/revoke'&&req.method==='POST'){
        for(const member of f.discord.members.values()){member.administrator=false;member.owner=false;}
        res.writeHead(200,{'Content-Type':'application/json'}).end('{}');return;
    }
    handler(req,res);
});
server.listen(port,'127.0.0.1',()=>console.log(`OFFLINE SYNTHETIC HARNESS ${origin}`));
process.on('SIGINT',async()=>{server.close();for(const cleanup of cleanups)await cleanup();process.exit(0);});
