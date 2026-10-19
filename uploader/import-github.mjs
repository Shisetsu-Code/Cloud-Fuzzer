#!/usr/bin/env node
// One-time/resumable import of existing Fuzzer-Manual GitHub screenshots to Cloud-Fuzzer R2/D1.
// Reads the public GitHub snapshot branch directly; never replays or downloads games.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';

const DEFAULT_REPO='Shisetsu-Code/Fuzzer-Manual';
const DEFAULT_RUN='pragmatic-20261019';
const DEFAULT_ENDPOINT='https://cloud-fuzzer.braian-n-l.workers.dev';
const VALID_REPO=/^[\w.-]+\/[\w.-]+$/;
const VALID_BRANCH=/^[\w.\/-]+$/;
const VALID_RUN=/^[a-z\d][a-z\d_-]{0,100}$/i;
const VALID_SLUG=/^[a-z\d][a-z\d-]{0,100}$/i;

export function parseOptions(args=[],env=process.env){
  const options={repo:DEFAULT_REPO,branch:'catalog-snapshots',runId:DEFAULT_RUN,
    endpoint:env.CLOUD_FUZZER_URL||DEFAULT_ENDPOINT,token:env.CLOUD_FUZZER_INGEST_TOKEN||'',
    concurrency:3,limit:Infinity,dryRun:false,stateFile:path.resolve('data/github-import-state.json')};
  for(const a of args){
    if(a==='--dry-run')options.dryRun=true;
    else if(a==='--help')options.help=true;
    else {
      const match=/^--(repo|branch|run-id|url|concurrency|limit|state-file)=(.+)$/.exec(a);
      if(!match)throw Error(`Unknown flag: ${a}`);
      const [,key,value]=match;
      if(key==='repo')options.repo=value;
      else if(key==='branch')options.branch=value;
      else if(key==='run-id')options.runId=value;
      else if(key==='url')options.endpoint=value;
      else if(key==='state-file')options.stateFile=path.resolve(value);
      else {
        const num=Number(value);
        if(!Number.isSafeInteger(num)||num<1)throw Error(`Invalid --${key}`);
        options[key]=num;
      }
    }
  }
  if(!VALID_REPO.test(options.repo)||!VALID_BRANCH.test(options.branch)||options.branch.includes('..')||!VALID_RUN.test(options.runId))throw Error('Invalid GitHub repo, branch or run ID');
  if(![1,2,3,4].includes(options.concurrency))throw Error('concurrency must be 1–4');
  options.endpoint=options.endpoint.replace(/\/+$/,'');
  if(!/^https:\/\/[a-z0-9.-]+(?::443)?$/i.test(options.endpoint))throw Error('CLOUD_FUZZER_URL must be an HTTPS origin');
  if(!options.help&&!options.dryRun&&!options.token)throw Error('Set CLOUD_FUZZER_INGEST_TOKEN. Do not post tokens in chat or GitHub.');
  return options;
}

async function fetchWithRetry(url,{fetchImpl=fetch,options={},tries=4,sleep=delay}={}){
  let error;
  for(let i=0;i<tries;i++){
    try{
      const response=await fetchImpl(url,{...options,signal:AbortSignal.timeout(45000)});
      if(response.ok)return response;
      if(![408,429,500,502,503,504].includes(response.status))throw Object.assign(Error(`HTTP ${response.status} from ${new URL(url).hostname}`),{permanent:true});
      error=Error(`HTTP ${response.status} from ${new URL(url).hostname}`);
    }catch(e){error=e;if(e.permanent)throw e;}
    if(i<tries-1)await sleep(Math.min(8000,500*2**i));
  }
  throw error;
}

export function selectImages(manifest,{limit=Infinity}={}){
  if(!manifest||!VALID_RUN.test(manifest.runId)||!manifest.entries||typeof manifest.entries!=='object'||Array.isArray(manifest.entries))throw Error('Invalid source manifest');
  const rows=[];
  for(const [key,row] of Object.entries(manifest.entries)){
    if(!row||!['ready','review'].includes(row.status)||!row.image||!row.metadata)continue;
    if(!VALID_SLUG.test(row.slug)||row.slug!==key||!Number.isSafeInteger(row.taskId)||row.taskId<1)throw Error('Invalid source slug/task ID');
    // Only known source paths, not arbitrary URLs/path traversal from GitHub JSON.
    if(![`shots/${row.slug}.jpg`,`review/${row.slug}.jpg`].includes(row.image)||row.metadata!==`metadata/${row.slug}.json`)throw Error('Unexpected source file path');
    rows.push(row);
  }
  return rows.sort((a,b)=>a.slug.localeCompare(b.slug)).slice(0,limit);
}

async function saveState(file,state){await fs.mkdir(path.dirname(file),{recursive:true});const tmp=file+`.${process.pid}.tmp`;await fs.writeFile(tmp,JSON.stringify(state,null,2)+'\n');await fs.rename(tmp,file);}
async function readState(file){try{const state=JSON.parse(await fs.readFile(file,'utf8'));if(!state||typeof state!=='object'||!state.files)throw Error('Invalid state file');return state;}catch(e){if(e.code==='ENOENT')return {files:{}};throw e;}}

export function uploadMetadata(manifest,row,metadata,sha,gitSha){
  if(typeof metadata!=='object'||metadata===null||metadata.slug!==row.slug)throw Error('Metadata slug mismatch');
  if(metadata.taskId!=null&&metadata.taskId!==row.taskId)throw Error('Metadata task ID mismatch');
  const width=metadata.viewport?.width??metadata.width;
  const height=metadata.viewport?.height??metadata.height;
  const info={runId:manifest.runId,slug:row.slug,taskId:row.taskId,state:row.state||metadata.state||'UNKNOWN',sha256:sha,
    controls:metadata.controls||[],source:{provider:'pragmatic',repository:DEFAULT_REPO,branch:'catalog-snapshots',commit:gitSha,
      screenshot:row.image,capturedAt:row.capturedAt||metadata.capturedAt||null,originalState:row.status}};
  if(Number.isSafeInteger(width)&&width>0)info.width=width;
  if(Number.isSafeInteger(height)&&height>0)info.height=height;
  return info;
}

export async function importScreenshots(config,{fetchImpl=fetch,log=console.log,sleep=delay}={}){
  const refUrl=`https://api.github.com/repos/${config.repo}/git/ref/heads/${config.branch}`;
  const ref=await (await fetchWithRetry(refUrl,{fetchImpl,sleep})).json();
  const sha=ref?.object?.sha;
  if(typeof sha!=='string'||!/^[0-9a-f]{40}$/i.test(sha))throw Error('GitHub branch ref has no valid commit SHA');
  const prefix=`https://raw.githubusercontent.com/${config.repo}/${sha}/runs/${config.runId}/`;
  const manifest=await (await fetchWithRetry(prefix+'manifest.json',{fetchImpl,sleep})).json();
  if(manifest.runId!==config.runId)throw Error('Run ID mismatch in GitHub manifest');
  const rows=selectImages(manifest,{limit:config.limit});
  log(`Found ${rows.length} ready/review screenshots in ${config.repo}@${sha.slice(0,12)}.`);
  if(config.dryRun)return {found:rows.length,uploaded:0,skipped:0,failed:0,sha};
  const state=await readState(config.stateFile);
  let next=0,uploaded=0,skipped=0,failed=0,writeQueue=Promise.resolve();
  const persist=()=>{writeQueue=writeQueue.then(()=>saveState(config.stateFile,state));return writeQueue;};
  const processRow=async row=>{
    const key=`${manifest.runId}:${row.slug}:${row.taskId}`;
    const [imgResp,mdResp]=await Promise.all([
      fetchWithRetry(prefix+row.image,{fetchImpl,sleep}),
      fetchWithRetry(prefix+row.metadata,{fetchImpl,sleep})
    ]);
    const [bytes,metadata]=await Promise.all([imgResp.arrayBuffer(),mdResp.json()]);
    const image=new Uint8Array(bytes);
    if(image.length<4||image[0]!==255||image[1]!==216||image.at(-2)!==255||image.at(-1)!==217)throw Error(`Invalid JPEG ${row.slug}`);
    const digest=createHash('sha256').update(image).digest('hex');
    if(state.files[key]===digest)return 'skipped';
    const info=uploadMetadata(manifest,row,metadata,digest,sha);
    if(config.repo!==DEFAULT_REPO)info.source.repository=config.repo;
    if(config.branch!=='catalog-snapshots')info.source.branch=config.branch;
    const form=new FormData();form.set('metadata',JSON.stringify(info));form.set('image',new Blob([image],{type:'image/jpeg'}),`${row.slug}.jpg`);
    const res=await fetchWithRetry(`${config.endpoint}/v1/captures`,{fetchImpl,sleep,options:{method:'POST',headers:{Authorization:`Bearer ${config.token}`},body:form}});
    const result=await res.json();
    if(result.capture?.imageSha256!==digest)throw Error(`Checksum mismatch from Cloudflare for ${row.slug}`);
    state.files[key]=digest;
    await persist();
    return result.capture?.unchanged?'skipped':'uploaded';
  };
  const workers=Array.from({length:Math.min(config.concurrency,rows.length)},async()=>{
    while(next<rows.length){const row=rows[next++];try{
      const status=await processRow(row);
      if(status==='uploaded'){uploaded++;log(`UPLOADED ${row.slug}`);}else skipped++;
    }catch(e){failed++;log(`ERROR ${row.slug}: ${e.message}`);}}
  });
  await Promise.all(workers);
  log(`FINISHED uploaded=${uploaded} skipped=${skipped} failed=${failed}`);
  return {found:rows.length,uploaded,skipped,failed,sha};
}

async function main(){
  const opts=parseOptions(process.argv.slice(2));
  if(opts.help){console.log('Usage: node uploader/import-github.mjs [--dry-run] [--limit=5] [--concurrency=3] [--run-id=pragmatic-20261019]');return;}
  const result=await importScreenshots(opts);
  if(result.failed)process.exitCode=1;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error(e.message);process.exitCode=1;});