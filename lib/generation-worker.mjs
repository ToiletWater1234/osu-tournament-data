// A process boundary also releases the presentation renderer's native memory
// at the end of each task, including any background threads it creates.
process.once('message',async options=>{
  try {
    const {generateDeck}=await import('./generator.mjs');
    const result=await generateDeck({...options,onProgress:(fraction,message)=>process.send?.({type:'progress',fraction,message})});
    process.send?.({type:'result',result});
  }catch(error){process.send?.({type:'failure',error:error.message||String(error)});}
});
