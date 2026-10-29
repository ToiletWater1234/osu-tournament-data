const packages=['jszip','sharp','@oai/artifact-tool'];
let missing=false;
for(const name of packages){
  try{await import(name);console.log(`OK ${name}`);}
  catch{missing=true;console.error(`Missing or unavailable: ${name}`);}
}
if(missing){
  console.error('Run npm install for public dependencies. The private @oai/artifact-tool 2.8.103 must be supplied separately; see README.md.');
  process.exitCode=1;
}
