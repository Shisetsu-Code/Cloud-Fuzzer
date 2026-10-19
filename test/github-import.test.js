import test from 'node:test';
import assert from 'node:assert/strict';
import {parseOptions,selectImages,importScreenshots} from '../uploader/import-github.mjs';

const runId='pragmatic-20261019',slug='3-magic-eggs';
const row={slug,status:'ready',state:'BASE',taskId:5,image:`shots/${slug}.jpg`,metadata:`metadata/${slug}.json`};
const manifest={runId,entries:{[slug]:row,other:{slug:'other',status:'failed'}}};

test('importer options require secure token except dry-run',()=>{
  assert.throws(()=>parseOptions([],{CLOUD_FUZZER_URL:'https://example.com'}),/INGEST_TOKEN/);
  assert.equal(parseOptions(['--dry-run'],{CLOUD_FUZZER_URL:'https://example.com'}).dryRun,true);
  assert.throws(()=>parseOptions(['--repo=../unsafe','--dry-run']),/Invalid GitHub/);
});
test('manifest selects only expected JPEG paths and rejects traversal',()=>{
  assert.deepEqual(selectImages(manifest).map(x=>x.slug),[slug]);
  const bad=structuredClone(manifest);bad.entries[slug].image='../../private';
  assert.throws(()=>selectImages(bad),/Unexpected source/);
});
test('dry-run reads pinned GitHub manifest but never uploads',async()=>{
  const hash='c'.repeat(40),urls=[];
  const fetchImpl=async url=>{
    urls.push(url);
    if(url==='https://api.github.com/repos/Shisetsu-Code/Fuzzer-Manual/git/ref/heads/catalog-snapshots')
      return Response.json({object:{sha:hash}});
    if(url===`https://raw.githubusercontent.com/Shisetsu-Code/Fuzzer-Manual/${hash}/runs/${runId}/manifest.json`)
      return Response.json(manifest);
    throw Error('unexpected fetch '+url);
  };
  const config=parseOptions(['--dry-run'],{});
  const result=await importScreenshots(config,{fetchImpl,log:()=>{},sleep:async()=>{}});
  assert.equal(result.found,1);assert.equal(result.uploaded,0);assert.equal(urls.length,2);
});
