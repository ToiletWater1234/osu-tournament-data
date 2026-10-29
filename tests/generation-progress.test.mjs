import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import {runGenerationJob} from '../lib/generation-job.mjs';
import {startProgressPolling} from '../public/generation-progress.js';
const workerUrl=new URL('./fixtures/busy-generation-worker.mjs',import.meta.url);

test('status HTTP requests remain responsive while the generation worker is CPU-bound',async()=>{
  let complete=false,start;
  const started=new Promise(resolve=>{start=resolve});
  const task=runGenerationJob({},()=>start(),{workerUrl}).then(result=>{complete=true;return result;});
  await started;
  const server=http.createServer((req,res)=>res.end(JSON.stringify({status:complete?'complete':'running'})));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const response=await fetch(`http://127.0.0.1:${server.address().port}`);
    assert.equal((await response.json()).status,'running');
    assert.deepEqual(await task,{slideCount:1});
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
test('worker failures are surfaced to the generation request',async()=>{
  await assert.rejects(runGenerationJob({fail:true},()=>{},{workerUrl}),/intentional test failure/);
});
test('slow status requests never overlap and completion stops polling',async()=>{
  let active=0,maxActive=0,calls=0,finish;
  const done=new Promise(resolve=>{finish=resolve});
  const stop=startProgressPolling('test',{
    intervalMs:5,timeoutMs:300,
    fetchImpl:async()=>{active++;maxActive=Math.max(maxActive,active);await delay(40);active--;calls++;return new Response(JSON.stringify({percent:40*calls,status:calls===3?'complete':'running'}));},
    onState:state=>{if(state.status==='complete')finish();}
  });
  try{await done;await delay(30);assert.equal(maxActive,1);assert.equal(calls,3);}finally{stop();}
});
test('a stalled status request times out and reports unavailability instead of filling connections',async()=>{
  let failed,finish;
  const done=new Promise(resolve=>{finish=resolve});
  const stop=startProgressPolling('test',{
    intervalMs:100,timeoutMs:20,
    fetchImpl:async(url,{signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('timed out')),{once:true})),
    onUnavailable:error=>{failed=error;finish();}
  });
  try{await done;assert.match(failed.message,/timed out/);}finally{stop();}
});
