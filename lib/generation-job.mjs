import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const activeWorkers=new Set();
process.once('exit',()=>{for(const worker of activeWorkers)worker.kill();});

export function runGenerationJob(options, onProgress, {workerUrl=new URL('./generation-worker.mjs',import.meta.url)}={}) {
  return new Promise((resolve,reject)=>{
    const worker=fork(fileURLToPath(workerUrl),[],{silent:true,windowsHide:true,serialization:'advanced'});
    activeWorkers.add(worker);
    let errorOutput='';
    worker.stdout.on('data',()=>{});
    worker.stderr.on('data',chunk=>{errorOutput=(errorOutput+chunk.toString()).slice(-4000);});
    let finished=false;
    const finish=(error,result)=>{
      if(finished)return;finished=true;
      worker.kill();
      if(error)reject(error);else resolve(result);
    };
    worker.on('message',message=>{
      if(message.type==='progress')onProgress?.(message.fraction,message.message);
      else if(message.type==='result')finish(null,message.result);
      else if(message.type==='failure')finish(new Error(message.error));
    });
    worker.on('error',error=>finish(error));
    worker.on('exit',code=>{activeWorkers.delete(worker);if(!finished)finish(new Error(`PPT 生成进程提前退出（代码 ${code}），请重试。${errorOutput?`\n${errorOutput}`:''}`));});
    worker.send(options);
  });
}
