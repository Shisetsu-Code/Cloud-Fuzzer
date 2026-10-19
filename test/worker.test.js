import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import worker from '../src/index.js';

const migrations=fs.readFileSync(new URL('../migrations/0001_init.sql',import.meta.url),'utf8');
const image=new Uint8Array([0xff,0xd8,3,4,5,6,7,8,0xff,0xd9]);
function fixture(){
  const sqlite=new DatabaseSync(':memory:');sqlite.exec(migrations);
  const DB={prepare(sql){const stmt=sqlite.prepare(sql);const bound=args=>({first:async()=>stmt.get(...args)??null,run:async()=>{const result=stmt.run(...args);return {success:true,meta:{changes:result.changes}};},all:async()=>({results:stmt.all(...args)})});return {...bound([]),bind(...args){return bound(args);}}},
    exec:async sql=>sqlite.exec(sql)};
  const images=new Map();
  const IMAGES={put:async(key,bytes)=>images.set(key,bytes.slice(0)),get:async key=>images.has(key)?{arrayBuffer:async()=>images.get(key).slice(0),body:new Blob([images.get(key)]).stream()}:null};
  return {env:{DB,IMAGES,INGEST_TOKEN:'test-ingest',REVIEW_TOKEN:'test-review',MCP_TOKEN:'test-mcp'},images,close:()=>sqlite.close()};
}
const req=(method,url,body,token='test-review')=>new Request('https://cloud.example'+url,{method,headers:{...(token?{Authorization:`Bearer ${token}`}:{})},body:body===undefined?undefined:JSON.stringify(body)});
async function post(env,url,payload,token='test-review'){return worker.fetch(req('POST',url,payload,token),env);}
async function json(response){return response.json();}
async function add(env,{slug='candy-rush',runId='pragmatic-20261019',taskId=1,bytes=image,replace=false}={}){
  const form=new FormData();form.set('metadata',JSON.stringify({runId,slug,taskId,state:'BASE',width:1024,height:576}));form.set('image',new Blob([bytes],{type:'image/jpeg'}),'test.jpg');if(replace)form.set('replace','true');
  return worker.fetch(new Request('https://cloud.example/v1/captures',{method:'POST',headers:{Authorization:'Bearer test-ingest'},body:form}),env);
}
test('upload + duplicate idempotence, private R2, D1 record and auth isolation',async()=>{
  const f=fixture();try{
    assert.equal((await worker.fetch(req('GET','/v1/stats',undefined,null),f.env)).status,401);
    assert.equal((await worker.fetch(req('GET','/v1/stats',undefined,'test-ingest'),f.env)).status,401);
    const response=await add(f.env);assert.equal(response.status,201);
    const c=(await json(response)).capture;assert.equal(c.status,'pending');assert.equal(c.slug,'candy-rush');assert.equal(c.sizeBytes,10);
    assert.equal(f.images.size,1);
    const again=(await json(await add(f.env))).capture;assert.equal(again.unchanged,true);assert.equal(f.images.size,1);
    const r=await worker.fetch(req('GET',`/v1/captures/${encodeURIComponent(c.id)}/image`,undefined,'test-review'),f.env);
    assert.equal(r.status,200);assert.deepEqual(new Uint8Array(await r.arrayBuffer()),image);
    const stats=await worker.fetch(req('GET','/v1/stats',undefined),f.env);assert.deepEqual((await json(stats)).counts,{pending:1,leased:0,classified:0,needs_review:0});
  }finally{f.close()}
});
test('queue lease, CAS, mark save, image hash, zero-mark classification',async()=>{
  const f=fixture();try{
    await add(f.env);await add(f.env,{slug:'aztec-blaze',taskId:2});
    const a=(await json(await post(f.env,'/v1/claim',{}))).capture;
    const b=(await json(await post(f.env,'/v1/claim',{}))).capture;
    assert.notEqual(a.id,b.id);assert.equal(a.status,'leased');assert.equal(a.revision,1);
    const bad=await post(f.env,'/v1/classify',{id:a.id,leaseId:a.leaseId,revision:a.revision,imageSha256:'0'.repeat(64),status:'classified',reviewer:'gpt',marks:[]});
    assert.equal(bad.status,409);
    const pay={id:a.id,leaseId:a.leaseId,revision:a.revision,imageSha256:a.imageSha256,status:'classified',reviewer:'gpt',marks:[{x:0.4,y:0.7,kind:'buy',label:'Buy Free Spins'}]};
    const success=await post(f.env,'/v1/classify',pay);assert.equal(success.status,200);assert.equal((await json(success)).capture.marks[0].kind,'buy');
    assert.equal((await post(f.env,'/v1/classify',pay)).status,409);
    const other=await post(f.env,'/v1/classify',{...pay,id:b.id,leaseId:b.leaseId,revision:b.revision,imageSha256:b.imageSha256,marks:[]});
    assert.equal(other.status,200);
    const row=await f.env.DB.prepare('SELECT * FROM classification_history').bind().all();assert.equal(row.results.length,2);
    assert.equal((await json(await post(f.env,'/v1/claim',{}))).capture,null);
  }finally{f.close();}
});
test('rejected malformed or stale marks, release, replacement and no cross-image overwrites',async()=>{
  const f=fixture();try{
    const first=(await json(await add(f.env))).capture;
    const claim=(await json(await post(f.env,'/v1/claim',{}))).capture;
    const payload={id:claim.id,leaseId:claim.leaseId,revision:claim.revision,imageSha256:claim.imageSha256,status:'classified',reviewer:'assistant',marks:[{x:1.3,y:0.5,kind:'buy',label:'bad'}]};
    assert.equal((await post(f.env,'/v1/classify',payload)).status,400);
    assert.equal((await post(f.env,'/v1/release',{id:claim.id,leaseId:claim.leaseId,revision:claim.revision})).status,200);
    assert.equal((await post(f.env,'/v1/classify',{...payload,marks:[]})).status,409);
    const changed=new Uint8Array(image);changed[4]=90;
    assert.equal((await add(f.env,{bytes:changed})).status,409);
    const replaced=(await json(await add(f.env,{bytes:changed,replace:true}))).capture;
    assert.equal(replaced.status,'pending');assert.notEqual(replaced.imageSha256,first.imageSha256);
  }finally{f.close();}
});
test('stateless MCP exposes image bytes and classification tools with private bearer',async()=>{
  const f=fixture();try{
    await add(f.env);
    const rpc=async(method,params,id=1,token='test-mcp')=>{const response=await worker.fetch(new Request('https://cloud.example/mcp',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json','Accept':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id,method,params})}),f.env);return {response,data:response.status===202?null:await response.json()};};
    const init=await rpc('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'test',version:'1'}});
    assert.equal(init.data.result.protocolVersion,'2025-03-26');
    const defs=await rpc('tools/list',{});assert.equal(defs.data.result.tools.length,5);
    const next=await rpc('tools/call',{name:'next_capture',arguments:{}});
    const [text,img]=next.data.result.content;const capture=JSON.parse(text.text).capture;
    assert.equal(img.mimeType,'image/jpeg');assert.deepEqual(new Uint8Array(Buffer.from(img.data,'base64')),image);
    const result=await rpc('tools/call',{name:'save_classification',arguments:{id:capture.id,leaseId:capture.leaseId,revision:capture.revision,imageSha256:capture.imageSha256,status:'classified',reviewer:'gpt',marks:[]}});
    assert.equal(JSON.parse(result.data.result.content[0].text).saved,true);
    const empty=await rpc('tools/call',{name:'next_capture',arguments:{}});assert.equal(JSON.parse(empty.data.result.content[0].text).empty,true);
    assert.equal((await rpc('tools/list',{},1,'test-review')).response.status,401);
  }finally{f.close();}
});
