import { DEFAULT_SETTINGS, MATCH_THRESHOLDS, CAPABILITIES } from '../dist/shared/domain.js';
const guild='100000000000000001', user='100000000000000002', channel='100000000000000003';
const at='2026-10-15T20:00:00.000Z';
const base=(n)=>({id:`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,guildId:guild,revision:1,createdAt:at,updatedAt:at});
const authority={userId:user,guildId:guild,owner:true,administrator:true,roles:[],capabilities:CAPABILITIES};
const metadata={name:'Example Community · PREVIEW',roles:[{id:guild,name:'@everyone',permissions:'0'},{id:'100000000000000004',name:'Moderators',permissions:'0'},{id:'100000000000000005',name:'Library editors',permissions:'0'}],channels:[{id:channel,name:'general',type:0},{id:'100000000000000006',name:'announcements',type:5},{id:'100000000000000007',name:'mod-log',type:0}]};
const settings={value:{...DEFAULT_SETTINGS,channels:[channel]},revision:1};
const groups=[{...base(20),name:'Community reference set'}];
const images=['Restricted promotion','Known repost','Prohibited graphic'].map((name,i)=>({...base(i+1),name,groupId:groups[0].id,enabled:true,sha256:'a'.repeat(64),objectKey:'preview',bytes:12000,width:768,height:768,createdBy:user}));
const rules=images.map((image,i)=>({...base(i+10),name:['Promotion removal','Repost review','Graphic timeout'][i],type:'individual',referenceId:image.id,groupId:null,mode:'transformed',threshold:[MATCH_THRESHOLDS.standard,.82,MATCH_THRESHOLDS.strict][i],action:['delete','review','timeout'][i],timeoutSeconds:600,deleteMessage:i===2,priority:0,enabled:true,automatic:i!==1,secondVerification:false,reason:'Matched a community image rule',approval:null,approvalCurrent:false}));
const events=[{...base(30),messageId:'100000000000000011',channelId:channel,userId:'100000000000000012',ruleId:rules[0].id,intended:'delete',actual:'suppressed',reason:'monitoring_only',matches:[],reviewStatus:'open'},{...base(31),messageId:'100000000000000013',channelId:channel,userId:'100000000000000014',ruleId:rules[1].id,intended:'review',actual:'suppressed',reason:'review',matches:[],reviewStatus:'open'}];
const credential={configured:false,status:'missing',validatedAt:null,lastError:null,revision:0};

export {guild,user,authority,metadata,settings,groups,images,rules,events,credential};
