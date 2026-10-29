process.once('message',options=>{
  if(options.fail){process.send({type:'failure',error:'intentional test failure'});}
  else{
    process.send({type:'progress',fraction:.1,message:'busy'});
    const deadline=Date.now()+1000;while(Date.now()<deadline){}
    process.send({type:'result',result:{slideCount:1}});
  }
});
