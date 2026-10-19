#!/usr/bin/env node
// Sync screenshots from Fuzzer-Manual's local catalog-exports into Cloudflare R2 + D1.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
const args=process.argv.slice(2);
const option=name=>{const token=args.find(x=>x.startsWith('--'+name+'='));return token?.slice(name.length+3)};
const source=path.resolve(option('source')||'');
const endpoint=(option('url')||process.env.CLOUD_FUZZER_URL||'').replace(/\/$/,'');
const token=process.env.CLOUD_FUZZER_INGEST_TOKEN;
const watch=args.includes('--watch');
const intervalMs=Number(option('interval-ms')||12000);
const concurrency=Math.max(1,Math.min(4,Number(option('concurrency')||2)));
const dryRun=args.includes('--dry-run');
if(!source||source===process.cwd()||!/^https:\/\//.test(endpoint)||(!dryRun&&!token)){
  console.error('Usage: CLOUD_FUZZER_URL=https://... CLOUD_FUZZER_INGEST_TOKEN=... node uploader/upload.mjs --source=../Fuzzer-Manual/data/catalog-exports/pragmatic-20261019 [--watch] [--dry-run]');
  process.exit(1);
}
if(!Number.isSafeInteger(intervalMs)||intervalMs<2000)throw Error('interval-ms must be >=2000');
const stateFile=path.join(source,'.cloud-upload-state.json');
async function readJSON(file,defaultValue){try{return JSON.parse(await fs.readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return defaultValue;throw e;}}
async function writeJSON(file,obj){const p=file+'.'+process.pid+'.tmp';await fs.writeFile(p,JSON.stringify(obj,null,2)+'\n');await fs.rename(p,file);}
const state=await readJSON(stateFile,{files:{}});
let writeQueue=Promise.resolve();
function persist(){writeQueue=writeQueue.then(()=>writeJSON(stateFile,state));return writeQueue;}
async function upload(row,runId){
  if(!['ready','review'].includes(row.status)||!row.image||!row.metadata)return {skipped:true};
  const base=path.resolve(source),image=path.resolve(base,row.image),metadata=path.resolve(base,row.metadata);
  if(!image.startsWith(base+path.sep)||!metadata.startsWith(base+path.sep))throw Error('unsafe path in manifest');
  let body,raw;
  try{[body,raw]=await Promise.all([fs.readFile(image),fs.readFile(metadata,'utf8')]);}
  catch(e){if(e.code==='ENOENT')return {skipped:true};throw e;}
  const md=JSON.parse(raw);
  const id=String(row.slug||'');
  if(!/^[a-z0-9][a-z0-9-]{0,100}$/i.test(id)||!Number.isSafeInteger(row.taskId)||row.taskId<1)throw Error('invalid game slug/taskId');
  const sha256=createHash('sha256').update(body).digest('hex');
  const key=`${runId}:${id}:${row.taskId}`;
  if(state.files[key]===sha256)return {skipped:true};
  const info={runId,slug:id,taskId:row.taskId,state:row.state||md.state||'UNKNOWN',sha256,
    width:md.viewport?.width||md.width||undefined,height:md.viewport?.height||md.height||undefined,
    controls:md.controls||[],source:{runId,slug:id,taskId:row.taskId,capturedAt:row.capturedAt||md.capturedAt||null}};
  const form=new FormData();form.set('metadata',JSON.stringify(info));form.set('image',new Blob([body],{type:'image/jpeg'}),`${id}.jpg`);
  if(dryRun){console.log('DRY RUN',key,body.length);return {dryRun:true};}
  let reason=null;
  for(let attempt=0;attempt<4;attempt++){
    try{
      const result=await fetch(endpoint+'/v1/captures',{method:'POST',headers:{Authorization:`Bearer ${token}`},body:form,signal:AbortSignal.timeout(30000)});
      const answer=await result.json().catch(()=>({}));
      if(!result.ok){
        if(![408,429,500,502,503,504].includes(result.status))throw Object.assign(Error(`Upload ${key}: HTTP ${result.status} ${answer.error||''}`),{permanent:true});
        throw Error(`HTTP ${result.status}`);
      }
      if(answer.capture?.imageSha256!==sha256)throw Error('server image hash differs');
      state.files[key]=sha256;await persist();
      console.log('UPLOADED',key,body.length);return {uploaded:true};
    }catch(e){reason=e;if(e.permanent)throw e;if(attempt<3)await delay(750*(2**attempt));}
  }
  throw reason;
}
async function once(){
  const manifest=await readJSON(path.join(source,'manifest.json'),null);
  if(!manifest||!manifest.runId||!manifest.entries)throw Error('missing/invalid catalog manifest');
  const rows=Object.values(manifest.entries);let next=0,ok=0,skip=0,failed=0;
  const count=Math.min(concurrency,rows.length);
  await Promise.all(Array.from({length:count},async()=>{
    while(next<rows.length){const row=rows[next++];try{const result=await upload(row,manifest.runId);if(result.uploaded)ok++;else skip++;}
      catch(e){failed++;console.error('ERROR',row.slug,e.message);}}
  }));
  console.log(`CYCLE uploaded=${ok} skipped=${skip} failed=${failed}`);return {ok,skip,failed};
}
do{await once();if(watch)await delay(intervalMs);}while(watch);
