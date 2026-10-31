const packages=['jszip','sharp','@xmldom/xmldom'];
let missing=false;
if(Number(process.versions.node.split('.')[0])<22){
  missing=true;console.error('Node.js 22 or newer is required.');
}
for(const name of packages){
  try{await import(name);console.log(`OK ${name}`);}
  catch{missing=true;console.error(`Missing or unavailable: ${name}`);}
}
if(missing){
  console.error('Dependencies are missing or incompatible. Run npm ci in the project folder, then retry.');
  process.exitCode=1;
}
