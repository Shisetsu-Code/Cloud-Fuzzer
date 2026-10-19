#!/usr/bin/env node
// Dependency-free MCP stdio proxy for Codex/Claude/Desktop. Worker implements the tools.
import readline from 'node:readline';
const endpoint=(process.env.CLOUD_FUZZER_URL||'').replace(/\/$/,'')+'/mcp';
const token=process.env.CLOUD_FUZZER_MCP_TOKEN;
if(!/^https:\/\//.test(endpoint)||!token){console.error('Set CLOUD_FUZZER_URL (HTTPS) and CLOUD_FUZZER_MCP_TOKEN');process.exit(1);}
const input=readline.createInterface({input:process.stdin,crlfDelay:Infinity});
// Serial by design: preserve request/response order and never mix stdout with logs.
for await(const line of input){
  if(!line.trim())continue;
  let id=null;try{id=JSON.parse(line).id??null;}catch{}
  try{
    const response=await fetch(endpoint,{method:'POST',headers:{'Authorization':`Bearer ${token}`,'Content-Type':'application/json','Accept':'application/json, text/event-stream'},body:line});
    if(response.status===202)continue;
    if(!response.ok)throw Error(`Cloud-Fuzzer MCP HTTP ${response.status}`);
    const json=await response.json();
    process.stdout.write(JSON.stringify(json)+'\n');
  }catch(e){if(id!==null)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,error:{code:-32000,message:e.message}})+'\n');else console.error(e.message);}
}
