// Domain logic is shared by HTTP and MCP. No game inspection, decisions or clicks.
export class ApiError extends Error {
  constructor(status, message){super(message);this.status=status;this.name='ApiError';}
}
const validName=/^[a-z0-9][a-z0-9_-]{0,100}$/i;
const kinds=new Set(['buy','navigate','pick','other']);
export function validateCaptureInfo(info){
  if(!info||typeof info!=='object')throw new ApiError(400,'metadata must be an object');
  const {runId,slug,taskId}=info;
  if(typeof runId!=='string'||typeof slug!=='string'||!validName.test(runId)||!validName.test(slug))throw new ApiError(400,'invalid runId or slug');
  if(!Number.isSafeInteger(taskId)||taskId<1)throw new ApiError(400,'invalid positive taskId');
  if(info.width!=null&&(!Number.isSafeInteger(info.width)||info.width<1||info.width>20000))throw new ApiError(400,'invalid width');
  if(info.height!=null&&(!Number.isSafeInteger(info.height)||info.height<1||info.height>20000))throw new ApiError(400,'invalid height');
  if(info.state!=null&&!['BASE','INTRO','UNKNOWN','CONFIRM','BUY_MENU','BONUS'].includes(info.state))throw new ApiError(400,'invalid capture state');
  return {id:`${runId}:${slug}:${taskId}`,runId,slug,taskId};
}
export function validateMarks(marks){
  if(!Array.isArray(marks)||marks.length>40)throw new ApiError(400,'marks must contain at most 40 items');
  return marks.map((m,i)=>{
    if(!m||typeof m!=='object'||!kinds.has(m.kind))throw new ApiError(400,`invalid mark kind at ${i}`);
    if(!Number.isFinite(m.x)||!Number.isFinite(m.y)||m.x<0||m.x>1||m.y<0||m.y>1)throw new ApiError(400,`invalid normalized coordinate at ${i}`);
    if(typeof m.label!=='string'||m.label.length>140)throw new ApiError(400,`invalid label at ${i}`);
    return {x:m.x,y:m.y,kind:m.kind,label:m.label};
  });
}
export function assertObject(value){if(!value||typeof value!=='object'||Array.isArray(value))throw new ApiError(400,'expected JSON object');return value;}
export function publicCapture(row){if(!row)return null;return {id:row.id,runId:row.run_id,slug:row.slug,taskId:row.task_id,state:JSON.parse(row.metadata_json||'{}').state||null,imageSha256:row.image_sha256,sizeBytes:row.size_bytes,width:row.width,height:row.height,status:row.status,revision:row.revision,leaseId:row.lease_id,leaseUntil:row.lease_until,marks:row.marks_json?JSON.parse(row.marks_json):[],metadata:JSON.parse(row.metadata_json||'{}'),createdAt:row.created_at,updatedAt:row.updated_at};}
export async function sha256Hex(data){const hash=await crypto.subtle.digest('SHA-256',data);return [...new Uint8Array(hash)].map(b=>b.toString(16).padStart(2,'0')).join('');}
const binaryMime='image/jpeg';
export async function ingest(env,info,bytes,{replace=false}={}){
  const parts=validateCaptureInfo(info);
  if(!(bytes instanceof ArrayBuffer))throw new ApiError(400,'missing binary image');
  if(bytes.byteLength<4||bytes.byteLength>8*1024*1024)throw new ApiError(413,'JPEG must be 4 bytes to 8 MiB');
  const arr=new Uint8Array(bytes);
  if(arr[0]!==255||arr[1]!==216||arr.at(-2)!==255||arr.at(-1)!==217)throw new ApiError(415,'only complete JPEG files allowed');
  const digest=await sha256Hex(bytes);
  if(info.sha256&&digest!==info.sha256.toLowerCase())throw new ApiError(400,'image hash mismatch');
  const existing=await env.DB.prepare('SELECT * FROM captures WHERE id=?').bind(parts.id).first();
  if(existing?.image_sha256===digest)return {...publicCapture(existing),unchanged:true};
  if(existing&&!replace)throw new ApiError(409,'capture ID already has a different image; use replace=true explicitly');
  const imageKey=`images/${parts.runId}/${parts.slug}/${parts.taskId}/${digest}.jpg`;
  const metadataJSON=JSON.stringify({...info,runId:parts.runId,slug:parts.slug,taskId:parts.taskId,imageSha256:digest});
  if(metadataJSON.length>128*1024)throw new ApiError(413,'metadata too large');
  await env.IMAGES.put(imageKey,bytes,{httpMetadata:{contentType:binaryMime},customMetadata:{sha256:digest}});
  if(existing){
    const write=await env.DB.prepare(`UPDATE captures SET image_key=?,image_sha256=?,size_bytes=?,width=?,height=?,metadata_json=?,status='pending',
      marks_json=NULL,reviewer=NULL,reviewed_at=NULL,lease_id=NULL,lease_until=NULL,revision=revision+1,updated_at=datetime('now')
      WHERE id=? AND image_sha256=? RETURNING id`).bind(imageKey,digest,bytes.byteLength,info.width??null,info.height??null,metadataJSON,parts.id,existing.image_sha256).first();
    if(!write)throw new ApiError(409,'capture changed during replacement, retry');
  }else{
    try{await env.DB.prepare(`INSERT INTO captures(id,run_id,slug,task_id,image_key,image_sha256,size_bytes,width,height,metadata_json)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).bind(parts.id,parts.runId,parts.slug,parts.taskId,imageKey,digest,bytes.byteLength,info.width??null,info.height??null,metadataJSON).run();}
    catch(e){const found=await env.DB.prepare('SELECT * FROM captures WHERE id=?').bind(parts.id).first();if(found?.image_sha256===digest)return {...publicCapture(found),unchanged:true};throw new ApiError(409,'capture ID conflict, retry');}
  }
  return publicCapture(await env.DB.prepare('SELECT * FROM captures WHERE id=?').bind(parts.id).first());
}
export async function getCapture(env,id){const row=await env.DB.prepare('SELECT * FROM captures WHERE id=?').bind(id).first();if(!row)throw new ApiError(404,'capture not found');return row;}
export async function claimCapture(env,{runId=null,leaseSeconds=180}={}){
  if(runId!=null&&!validName.test(runId))throw new ApiError(400,'invalid runId');
  if(!Number.isSafeInteger(leaseSeconds)||leaseSeconds<30||leaseSeconds>900)throw new ApiError(400,'leaseSeconds must be 30..900');
  const now=Math.floor(Date.now()/1000);
  for(let i=0;i<12;i++){
    const filters=runId?`AND run_id=?`:'';
    const statement=env.DB.prepare(`SELECT id FROM captures WHERE (status='pending' OR (status='leased' AND lease_until<=?)) ${filters}
      ORDER BY created_at ASC, id ASC LIMIT 1`);
    const candidate=await (runId?statement.bind(now,runId):statement.bind(now)).first();
    if(!candidate)return null;
    const lease=crypto.randomUUID();
    const updated=await env.DB.prepare(`UPDATE captures SET status='leased',lease_id=?,lease_until=?,revision=revision+1,updated_at=datetime('now')
      WHERE id=? AND (status='pending' OR (status='leased' AND lease_until<=?)) RETURNING *`)
      .bind(lease,now+leaseSeconds,candidate.id,now).first();
    if(updated)return publicCapture(updated);
  }
  throw new ApiError(409,'queue is busy, retry');
}
export async function saveClassification(env,input){
  assertObject(input);
  const {id,leaseId,revision,imageSha256}=input;
  if(typeof id!=='string'||id.length>400||typeof leaseId!=='string'||leaseId.length>150||!Number.isSafeInteger(revision)||revision<0)throw new ApiError(400,'invalid lease identity or revision');
  if(typeof imageSha256!=='string'||!/^[a-f0-9]{64}$/i.test(imageSha256))throw new ApiError(400,'invalid image SHA');
  if(!['classified','needs_review'].includes(input.status))throw new ApiError(400,'invalid classification status');
  if(typeof input.reviewer!=='string'||!input.reviewer.trim()||input.reviewer.length>80)throw new ApiError(400,'reviewer required');
  const marks=validateMarks(input.marks);
  const serialized=JSON.stringify(marks);const now=Math.floor(Date.now()/1000);
  const updated=await env.DB.prepare(`UPDATE captures SET marks_json=?,status=?,revision=revision+1,
    reviewer=?,reviewed_at=datetime('now'),lease_id=NULL,lease_until=NULL,updated_at=datetime('now')
    WHERE id=? AND status='leased' AND lease_id=? AND lease_until>? AND revision=? AND image_sha256=? RETURNING *`)
    .bind(serialized,input.status,input.reviewer.trim(),id,leaseId,now,revision,imageSha256.toLowerCase()).first();
  if(!updated)throw new ApiError(409,'stale lease/revision/image; re-claim a capture');
  // Classification itself is atomically persisted in captures; history is best-effort.
  try{await env.DB.prepare(`INSERT INTO classification_history(capture_id,image_sha256,revision,status,marks_json,reviewer)
    VALUES(?,?,?,?,?,?)`).bind(id,updated.image_sha256,updated.revision,input.status,serialized,input.reviewer.trim()).run();}
  catch(e){console.error('classification history insert failed',e);}
  return publicCapture(updated);
}
export async function releaseCapture(env,input){
  const {id,leaseId,revision}=assertObject(input);
  if(typeof id!=='string'||typeof leaseId!=='string'||!Number.isSafeInteger(revision))throw new ApiError(400,'invalid release');
  const updated=await env.DB.prepare(`UPDATE captures SET status='pending',lease_id=NULL,lease_until=NULL,revision=revision+1,updated_at=datetime('now')
    WHERE id=? AND status='leased' AND lease_id=? AND revision=? RETURNING *`).bind(id,leaseId,revision).first();
  if(!updated)throw new ApiError(409,'stale lease');return publicCapture(updated);
}
export async function stats(env,runId){
  if(runId&&!validName.test(runId))throw new ApiError(400,'invalid runId');
  const rows=runId?await env.DB.prepare('SELECT status,COUNT(*) AS count FROM captures WHERE run_id=? GROUP BY status').bind(runId).all():
    await env.DB.prepare('SELECT status,COUNT(*) AS count FROM captures GROUP BY status').all();
  const counts={pending:0,leased:0,classified:0,needs_review:0};for(const row of rows.results||[])counts[row.status]=row.count;
  return {counts,total:Object.values(counts).reduce((a,b)=>a+b,0)};
}
