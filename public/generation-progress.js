// At most one status request is outstanding. Slow generation must not fill all
// browser connections with overlapping polls and prevent its own final reply.
export function startProgressPolling(generationId,{onState,onUnavailable,fetchImpl=fetch,intervalMs=1000,timeoutMs=5000}={}) {
  let stopped=false,timer=null,controller=null;
  async function poll(){
    controller=new AbortController();
    const timeout=setTimeout(()=>controller.abort(),timeoutMs);
    try{
      const response=await fetchImpl(`/api/generation-progress?id=${encodeURIComponent(generationId)}`,{cache:'no-store',signal:controller.signal});
      if(!response.ok)throw new Error(`进度查询 HTTP ${response.status}`);
      const state=await response.json();
      if(!stopped){onState?.(state);if(state.status==='failed'||state.status==='complete')stopped=true;}
    }catch(error){if(!stopped)onUnavailable?.(error);}
    finally{clearTimeout(timeout);controller=null;if(!stopped)timer=setTimeout(poll,intervalMs);}
  }
  timer=setTimeout(poll,0);
  return ()=>{stopped=true;clearTimeout(timer);controller?.abort();};
}
