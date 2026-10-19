import {ApiError,ingest,claimCapture,saveClassification,releaseCapture,getCapture,publicCapture,stats} from './core.js';
import {handleMcp} from './mcp.js';

function eqSecret(a,b){if(typeof a!=='string'||typeof b!=='string'||!a||!b)return false;let difference=a.length^b.length;const len=Math.max(a.length,b.length);for(let i=0;i<len;i++)difference|=(a.charCodeAt(i)||0)^(b.charCodeAt(i)||0);return difference===0;}
function authorize(req,secret){const h=req.headers.get('Authorization')||'';return h.startsWith('Bearer ')&&eqSecret(h.slice(7),secret);}
function output(data,status=200,headers={}){return new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...headers}});}
function deny(){return output({error:'unauthorized'},401,{'WWW-Authenticate':'Bearer'});}
async function readJSON(req){if(Number(req.headers.get('Content-Length'))>256000)throw new ApiError(413,'request too large');let value;try{value=await req.json();}catch{throw new ApiError(400,'invalid JSON');}if(!value||typeof value!=='object'||Array.isArray(value))throw new ApiError(400,'JSON object required');return value;}
export default {
  async fetch(req,env){
    try{
      const url=new URL(req.url),path=url.pathname;
      if(req.method==='GET'&&path==='/health')return output({ok:true,service:'cloud-fuzzer',storage:'R2',queue:'D1',mcp:'/mcp'});
      if(path==='/mcp'){
        if(!authorize(req,env.MCP_TOKEN))return deny();
        return handleMcp(req,env);
      }
      if(path==='/v1/captures'&&req.method==='POST'){
        if(!authorize(req,env.INGEST_TOKEN))return deny();
        if(Number(req.headers.get('Content-Length'))>9*1024*1024)throw new ApiError(413,'request too large');
        if(!req.headers.get('Content-Type')?.startsWith('multipart/form-data'))throw new ApiError(415,'multipart form required');
        const data=await req.formData();
        const image=data.get('image'),metadata=data.get('metadata');
        if(!image||typeof image.arrayBuffer!=='function'||typeof metadata!=='string')throw new ApiError(400,'image and metadata required');
        if(image.size>8*1024*1024)throw new ApiError(413,'image too large');
        let info;try{info=JSON.parse(metadata);}catch{throw new ApiError(400,'invalid metadata JSON');}
        return output({capture:await ingest(env,info,await image.arrayBuffer(),{replace:data.get('replace')==='true'})},201);
      }
      if(path.startsWith('/v1/')){
        if(!authorize(req,env.REVIEW_TOKEN))return deny();
        if(path==='/v1/claim'&&req.method==='POST')return output({capture:await claimCapture(env,await readJSON(req))});
        if(path==='/v1/classify'&&req.method==='POST')return output({capture:await saveClassification(env,await readJSON(req))});
        if(path==='/v1/release'&&req.method==='POST')return output({capture:await releaseCapture(env,await readJSON(req))});
        if(path==='/v1/stats'&&req.method==='GET')return output(await stats(env,url.searchParams.get('runId')));
        const match=/^\/v1\/captures\/([^/]+)(\/image)?$/.exec(path);
        if(match&&req.method==='GET'){
          const id=decodeURIComponent(match[1]);const raw=await getCapture(env,id);
          if(match[2]){
            const image=await env.IMAGES.get(raw.image_key);
            if(!image)throw new ApiError(404,'image not found');
            return new Response(image.body,{headers:{'Content-Type':'image/jpeg','Cache-Control':'private, no-store','X-Image-SHA256':raw.image_sha256,'X-Content-Type-Options':'nosniff'}});
          }
          return output({capture:publicCapture(raw)});
        }
      }
      return output({error:'not found'},404);
    }catch(error){
      if(!(error instanceof ApiError))console.error('worker failure',error);
      const status=error instanceof ApiError?error.status:500;
      return output({error:status===500?'internal server error':error.message},status);
    }
  }
};
