// Stateless Streamable HTTP MCP endpoint. Remote ChatGPT/Codex clients may use /mcp.
import {ApiError,claimCapture,getCapture,saveClassification,releaseCapture,stats} from './core.js';

const schema=(properties,required=[])=>({type:'object',properties,required,additionalProperties:false});
const str={type:'string'};
const markSchema={type:'object',properties:{x:{type:'number',minimum:0,maximum:1},y:{type:'number',minimum:0,maximum:1},kind:{enum:['buy','navigate','pick','other']},label:str},required:['x','y','kind','label'],additionalProperties:false};
export const tools=[
  {name:'next_capture',description:'Claim the next pending screenshot; returns its JPEG as a vision image, its ID, lease, source hash and metadata. Classify and save quickly.',inputSchema:schema({runId:str,leaseSeconds:{type:'integer',minimum:30,maximum:900}})},
  {name:'save_classification',description:'Persist normalized click marks once, tied to the exact screenshot SHA and current lease. Zero marks is allowed. Never click or play the game.',inputSchema:schema({id:str,leaseId:str,revision:{type:'integer'},imageSha256:str,status:{enum:['classified','needs_review']},reviewer:str,marks:{type:'array',maxItems:40,items:markSchema}},['id','leaseId','revision','imageSha256','status','reviewer','marks'])},
  {name:'release_capture',description:'Release an active capture back to the queue without saving marks.',inputSchema:schema({id:str,leaseId:str,revision:{type:'integer'}},['id','leaseId','revision'])},
  {name:'queue_stats',description:'Return pending, leased, classified and needs_review counts.',inputSchema:schema({runId:str})},
  {name:'get_capture',description:'Read capture metadata and its JPEG (for retrying a still-valid lease).',inputSchema:schema({id:str,leaseId:str},['id','leaseId'])}
];
function jsonRpcResult(id,result){return {jsonrpc:'2.0',id,result};}
function jsonRpcError(id,code,message){return {jsonrpc:'2.0',id,error:{code,message}};}
const asText=obj=>({type:'text',text:JSON.stringify(obj)});
function toBase64(bytes){let out='';const data=new Uint8Array(bytes);for(let i=0;i<data.length;i+=12288){out+=btoa(String.fromCharCode(...data.subarray(i,Math.min(i+12288,data.length))));}return out;}
// The chunk multiple of 3 above is deliberate; otherwise concatenated base64 is invalid.
async function withImage(env,row){
  const image=await env.IMAGES.get(row.image_key);
  if(!image)throw new ApiError(404,'JPEG missing in R2');
  const data=await image.arrayBuffer();
  return {content:[asText({capture:{...row,metadata:JSON.parse(row.metadata_json||'{}'),marks:row.marks_json?JSON.parse(row.marks_json):[]},note:'Coordinates must be normalized to the supplied image. Save then request next.'}),{type:'image',mimeType:'image/jpeg',data:toBase64(data)}]};
}
async function toolCall(env,name,args){
  switch(name){
    case 'next_capture': {
      const capture=await claimCapture(env,args);
      if(!capture)return {content:[asText({empty:true,message:'No pending capture'})]};
      const raw=await getCapture(env,capture.id);
      const out=await withImage(env,raw);
      // Use public fields to avoid leaking storage paths / server-only columns.
      out.content[0]=asText({capture,note:'Review the supplied image, then save marks and immediately request next_capture.'});
      return out;
    }
    case 'save_classification':return {content:[asText({saved:true,capture:await saveClassification(env,args)})]};
    case 'release_capture':return {content:[asText({released:true,capture:await releaseCapture(env,args)})]};
    case 'queue_stats':return {content:[asText(await stats(env,args.runId))]};
    case 'get_capture':{
      const row=await getCapture(env,args.id);
      const now=Math.floor(Date.now()/1000);
      if(row.status!=='leased'||row.lease_id!==args.leaseId||row.lease_until<=now)throw new ApiError(409,'lease is not active');
      return withImage(env,row);
    }
    default:throw new ApiError(404,'unknown tool');
  }
}
export async function handleMcp(request,env){
  if(request.method==='GET')return new Response('Streamable MCP uses POST for this stateless server',{status:405,headers:{Allow:'POST, DELETE'}});
  if(request.method==='DELETE')return new Response(null,{status:204});
  if(request.method!=='POST')return new Response(null,{status:405,headers:{Allow:'POST, DELETE'}});
  let message;
  try{message=await request.json();}catch{return new Response(JSON.stringify(jsonRpcError(null,-32700,'invalid JSON')),{status:400,headers:{'Content-Type':'application/json'}});}
  const id=message?.id??null;
  if(message?.jsonrpc!=='2.0'||typeof message.method!=='string')return respond(jsonRpcError(id,-32600,'invalid request'),400);
  if(id===null){return new Response(null,{status:202});}
  try{
    switch(message.method){
      case 'initialize':return respond(jsonRpcResult(id,{protocolVersion:'2025-03-26',capabilities:{tools:{listChanged:false}},serverInfo:{name:'cloud-fuzzer',version:'0.1.0'}}));
      case 'ping':return respond(jsonRpcResult(id,{}));
      case 'tools/list':return respond(jsonRpcResult(id,{tools}));
      case 'tools/call': {
        const name=message.params?.name,args=message.params?.arguments||{};
        if(typeof name!=='string'||args===null||typeof args!=='object'||Array.isArray(args))throw new ApiError(400,'invalid tool arguments');
        return respond(jsonRpcResult(id,await toolCall(env,name,args)));
      }
      default:return respond(jsonRpcError(id,-32601,'method not found'));
    }
  }catch(e){const status=e instanceof ApiError?e.status:500;return respond(jsonRpcResult(id,{content:[asText({error:status===500?'internal error':e.message,status})],isError:true}));}
}
function respond(obj,status=200){return new Response(JSON.stringify(obj),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});}
