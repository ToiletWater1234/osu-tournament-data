// Edit the user's OOXML template directly. Only public npm dependencies are used;
// original masters, layouts, theme, media, text runs and slide dimensions survive.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import sharp from 'sharp';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';

const NS = {
  p:'http://schemas.openxmlformats.org/presentationml/2006/main',
  a:'http://schemas.openxmlformats.org/drawingml/2006/main',
  r:'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  rel:'http://schemas.openxmlformats.org/package/2006/relationships',
  ct:'http://schemas.openxmlformats.org/package/2006/content-types',
};
const EMU = 9525; // All layout measurements are CSS pixels at 96 DPI.
const xml = node => new XMLSerializer().serializeToString(node);
const parse = text => new DOMParser().parseFromString(text,'application/xml');
const children = node => Array.from(node?.childNodes || []).filter(n=>n.nodeType===1);
const child = (node,name) => children(node).find(n=>n.nodeName===name);
const descendants = (node,name) => Array.from(node.getElementsByTagName(name));
const first = (node,name) => descendants(node,name)[0];
function element(doc,name,attrs={}) {
  const prefix=name.split(':')[0];
  const node=doc.createElementNS(NS[prefix] || NS.rel,name);
  for(const [key,value] of Object.entries(attrs)) node.setAttribute(key,String(value));
  return node;
}
function ensure(parent,name,attrs={}) {
  let node=child(parent,name);
  if(!node){node=element(parent.ownerDocument,name,attrs);parent.appendChild(node);}
  return node;
}
function removeChildren(parent,names) {
  for(const node of children(parent))if(names.includes(node.nodeName))parent.removeChild(node);
}
const numberAttr=(node,key,fallback=0)=>node?.hasAttribute(key)?Number(node.getAttribute(key)):fallback;

function groupTransform(parent) {
  if(!parent || parent.nodeName!=='p:grpSp')return {x:0,y:0,sx:1,sy:1};
  const outer=groupTransform(parent.parentNode);
  const transform=child(child(parent,'p:grpSpPr'),'a:xfrm');
  const off=child(transform,'a:off'),ext=child(transform,'a:ext');
  const origin=child(transform,'a:chOff'),size=child(transform,'a:chExt');
  const sx=numberAttr(ext,'cx',1)/(numberAttr(size,'cx',1)||1);
  const sy=numberAttr(ext,'cy',1)/(numberAttr(size,'cy',1)||1);
  return {x:outer.x+outer.sx*(numberAttr(off,'x')-numberAttr(origin,'x')*sx),
    y:outer.y+outer.sy*(numberAttr(off,'y')-numberAttr(origin,'y')*sy),sx:outer.sx*sx,sy:outer.sy*sy};
}

function colorNode(doc,value) {
  let color=String(value || '#FFFFFF'),alpha=1;
  const rgba=color.match(/^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)$/i);
  if(rgba){color='#'+rgba.slice(1,4).map(v=>Number(v).toString(16).padStart(2,'0')).join('');alpha=Number(rgba[4]);}
  const slash=color.match(/^(#[\da-f]{6})\/([\d.]+)$/i);
  if(slash){color=slash[1];alpha=Number(slash[2]);}
  if(!/^#[\da-f]{6}$/i.test(color))throw new Error('Unsupported PPT color: '+value);
  const node=element(doc,'a:srgbClr',{val:color.slice(1).toUpperCase()});
  if(alpha!==1)node.appendChild(element(doc,'a:alpha',{val:Math.round(alpha*100000)}));
  return node;
}
function fillNode(doc,value) {
  if(!value || value==='none' || value.type==='none')return element(doc,'a:noFill');
  const text=typeof value==='string'?value:(value.color || value.fill);
  const gradient=text?.match(/^linear\((\d+)deg,\s*(#[\da-f]{6}(?:\/[\d.]+)?)\s+(\d+)%,\s*(#[\da-f]{6}(?:\/[\d.]+)?)\s+(\d+)%\)$/i);
  if(gradient){
    const fill=element(doc,'a:gradFill',{rotWithShape:1}),stops=element(doc,'a:gsLst');
    for(const [color,pos] of [[gradient[2],gradient[3]],[gradient[4],gradient[5]]]){
      const stop=element(doc,'a:gs',{pos:Number(pos)*1000});stop.appendChild(colorNode(doc,color));stops.appendChild(stop);
    }
    fill.appendChild(stops);fill.appendChild(element(doc,'a:lin',{ang:Number(gradient[1])*60000,scaled:0}));return fill;
  }
  const fill=element(doc,'a:solidFill');fill.appendChild(colorNode(doc,text));return fill;
}
function applyFill(parent,value) {
  removeChildren(parent,['a:noFill','a:solidFill','a:gradFill','a:blipFill','a:pattFill','a:grpFill']);
  // Fill precedes the line, effects and 3D properties in DrawingML.
  const textProps=['a:rPr','a:defRPr','a:endParaRPr'].includes(parent.nodeName);
  const afterFill=textProps?['a:effectLst','a:effectDag','a:highlight','a:uLnTx','a:uLn','a:uFillTx','a:uFill','a:latin','a:ea','a:cs','a:sym','a:hlinkClick','a:hlinkMouseOver','a:extLst']:['a:ln','a:effectLst','a:effectDag','a:scene3d','a:sp3d','a:extLst'];
  const before=children(parent).find(n=>afterFill.includes(n.nodeName));
  parent.insertBefore(fillNode(parent.ownerDocument,value),before || null);
}

class TextRange {
  constructor(text,start,length){this.text=text;this.start=start;this.length=length;}
  replace(value){this.text.replaceRange(this.start,this.length,String(value));}
  set color(value){this.text.formatRange(this.start,this.length,{color:value});}
  set bold(value){this.text.formatRange(this.start,this.length,{bold:value});}
}

class ShapeText {
  constructor(shape){this.shape=shape;}
  get body(){return ensure(this.shape.node,'p:txBody');}
  get paragraphs(){return children(this.body).filter(n=>n.nodeName==='a:p');}
  snapshot(){
    const paragraphs=this.paragraphs,tokens=[];
    paragraphs.forEach((paragraph,index)=>{
      const paragraphProps=child(paragraph,'a:pPr');
      const fallback=child(paragraphProps,'a:defRPr') || child(paragraph,'a:endParaRPr');
      for(const run of children(paragraph)){
        if(!['a:r','a:fld','a:br'].includes(run.nodeName))continue;
        const style=child(run,'a:rPr') || fallback;
        const text=run.nodeName==='a:br'?'\n':(child(run,'a:t')?.textContent || '');
        for(const ch of text.split(''))tokens.push({ch,style,paragraph:index});
      }
      if(index<paragraphs.length-1)tokens.push({ch:'\n',style:tokens.at(-1)?.style || fallback,paragraph:index});
    });
    return {tokens,paragraphs};
  }
  get value(){return this.snapshot().tokens.map(t=>t.ch).join('');}
  write(tokens,oldParagraphs){
    const doc=this.body.ownerDocument;
    for(const paragraph of this.paragraphs)this.body.removeChild(paragraph);
    const lines=[[]];for(const token of tokens){if(token.ch==='\n')lines.push([]);else lines.at(-1).push(token);}
    lines.forEach((line,index)=>{
      const source=oldParagraphs[line[0]?.paragraph ?? Math.min(index,oldParagraphs.length-1)];
      const paragraph=element(doc,'a:p'),props=child(source,'a:pPr'),end=child(source,'a:endParaRPr');
      if(props)paragraph.appendChild(props.cloneNode(true));
      let current=null,signature=null;
      for(const token of line){
        const key=token.style?xml(token.style):'';
        if(!current || key!==signature){
          const run=element(doc,'a:r');
          if(token.style){const style=token.style.cloneNode(true);if(style.nodeName!=='a:rPr'){const copy=element(doc,'a:rPr');for(const a of Array.from(style.attributes))copy.setAttribute(a.name,a.value);for(const c of Array.from(style.childNodes))copy.appendChild(c.cloneNode(true));run.appendChild(copy);}else run.appendChild(style);}
          current=element(doc,'a:t');run.appendChild(current);paragraph.appendChild(run);signature=key;
        }
        current.appendChild(doc.createTextNode(token.ch));
      }
      if(end)paragraph.appendChild(end.cloneNode(true));
      this.body.appendChild(paragraph);
    });
  }
  set(value){
    const {tokens,paragraphs}=this.snapshot();
    const lines=String(value).split('\n'),next=[];
    lines.forEach((line,index)=>{
      const paragraph=Math.min(index,Math.max(0,paragraphs.length-1));
      const style=tokens.find(t=>t.paragraph===paragraph&&t.ch!=='\n')?.style || tokens[0]?.style || null;
      for(const ch of line.split(''))next.push({ch,style,paragraph});
      if(index<lines.length-1)next.push({ch:'\n',style,paragraph});
    });
    this.write(next,paragraphs);
  }
  replace(from,to){const at=this.value.indexOf(from);if(at>=0)this.replaceRange(at,from.length,String(to));}
  replaceRange(start,length,value){
    const {tokens,paragraphs}=this.snapshot();
    const basis=tokens[start] || tokens[start-1] || {style:null,paragraph:0};
    tokens.splice(start,length,...String(value).split('').map(ch=>({...basis,ch})));
    this.write(tokens,paragraphs);
  }
  getRange(start,length){return new TextRange(this,start,length);}
  formatRange(start,length,values){
    const {tokens,paragraphs}=this.snapshot(),doc=this.body.ownerDocument;
    for(let i=start;i<Math.min(start+length,tokens.length);i++){
      const token=tokens[i],style=token.style?.cloneNode(true) || element(doc,'a:rPr');
      this.formatProperties(style,values);tokens[i]={...token,style};
    }
    this.write(tokens,paragraphs);
  }
  formatProperties(props,values){
    if(values.fontSize!==undefined)props.setAttribute('sz',Math.round(values.fontSize*75));
    if(values.bold!==undefined)props.setAttribute('b',values.bold?'1':'0');
    if(values.color!==undefined)applyFill(props,values.color);
    if(values.typeface!==undefined)for(const type of ['a:latin','a:ea','a:cs'])ensure(props,type).setAttribute('typeface',values.typeface);
    if(values.outline!==undefined){
      const line=ensure(props,'a:ln');line.setAttribute('w',Math.round((values.outline.width || 0)*EMU));applyFill(line,values.outline.fill || 'none');
      if(props.firstChild!==line)props.insertBefore(line,props.firstChild);
    }
  }
  format(values){
    for(const paragraph of this.paragraphs){
      const props=ensure(paragraph,'a:pPr');
      if(paragraph.firstChild!==props)paragraph.insertBefore(props,paragraph.firstChild);
      this.formatProperties(ensure(props,'a:defRPr'),values);
      this.formatProperties(ensure(paragraph,'a:endParaRPr'),values);
      for(const run of children(paragraph).filter(n=>['a:r','a:fld','a:br'].includes(n.nodeName))){
        const runProps=ensure(run,'a:rPr');if(run.firstChild!==runProps)run.insertBefore(runProps,run.firstChild);this.formatProperties(runProps,values);
      }
    }
  }
  set typeface(value){this.format({typeface:value});}
  set fontSize(value){this.format({fontSize:value});}
  set bold(value){this.format({bold:value});}
  set color(value){this.format({color:value});}
  set outline(value){this.format({outline:value});}
  set style(value){this.format({typeface:value.fontFamily});}
  set alignment(value){for(const p of this.paragraphs){const props=ensure(p,'a:pPr');if(p.firstChild!==props)p.insertBefore(props,p.firstChild);props.setAttribute('algn',({left:'l',right:'r',center:'ctr'})[value] || value);}}
  set verticalAlignment(value){ensure(this.body,'a:bodyPr').setAttribute('anchor',value==='middle'?'ctr':value==='bottom'?'b':'t');}
  set wrap(value){ensure(this.body,'a:bodyPr').setAttribute('wrap',value==='none'?'none':'square');}
  set autoFit(value){const props=ensure(this.body,'a:bodyPr');removeChildren(props,['a:noAutofit','a:normAutofit','a:spAutoFit']);props.appendChild(element(props.ownerDocument,value==='shrinkText'?'a:normAutofit':'a:noAutofit'));}
}

class TemplateElement {
  constructor(slide,node){this.slide=slide;this.node=node;this.id=slide.uid+':'+first(node,'p:cNvPr').getAttribute('id');this.text=new ShapeText(this);}
  get name(){return first(this.node,'p:cNvPr').getAttribute('name');}
  set name(value){first(this.node,'p:cNvPr').setAttribute('name',value);}
  get kind(){return this.node.nodeName==='p:pic'?'image':child(this.node,'p:txBody')&&this.text.value.trim()?'textbox':'shape';}
  get position(){
    const shape=this;
    return new Proxy({}, {
      get(_target,key){return shape.getFrame()[key];},
      set(_target,key,value){shape.setFrame({...shape.getFrame(),[key]:value});return true;},
      ownKeys(){return ['left','top','width','height'];},
      getOwnPropertyDescriptor(){return {enumerable:true,configurable:true};},
    });
  }
  set position(value){this.setFrame(value);}
  getFrame(){
    const props=child(this.node,'p:spPr'),transform=child(props,'a:xfrm');
    const off=child(transform,'a:off'),ext=child(transform,'a:ext'),g=groupTransform(this.node.parentNode);
    return {left:(g.x+numberAttr(off,'x')*g.sx)/EMU,top:(g.y+numberAttr(off,'y')*g.sy)/EMU,width:numberAttr(ext,'cx')*g.sx/EMU,height:numberAttr(ext,'cy')*g.sy/EMU};
  }
  setFrame(value){
    const g=groupTransform(this.node.parentNode),props=ensure(this.node,'p:spPr'),transform=ensure(props,'a:xfrm');
    if(props.firstChild!==transform)props.insertBefore(transform,props.firstChild);
    const off=ensure(transform,'a:off'),ext=ensure(transform,'a:ext');
    for(const [key,native] of [['left','x'],['top','y']])if(value[key]!==undefined)off.setAttribute(native,Math.round((value[key]*EMU-g[native])/(key==='left'?g.sx:g.sy)));
    for(const [key,native] of [['width','cx'],['height','cy']])if(value[key]!==undefined)ext.setAttribute(native,Math.round(value[key]*EMU/(key==='width'?g.sx:g.sy)));
  }
  get frame(){return this.getFrame();}
  set frame(value){this.setFrame(value);}
  get crop(){const rect=first(this.node,'a:srcRect');return rect?Object.fromEntries(['l','t','r','b'].map(k=>[k,numberAttr(rect,k)])):null;}
  set crop(value){const fill=child(this.node,'p:blipFill');if(!fill)return;removeChildren(fill,['a:srcRect']);if(value){const rect=element(fill.ownerDocument,'a:srcRect',value);fill.insertBefore(rect,child(fill,'a:stretch') || null);}}
  get fit(){return this._fit || 'cover';} set fit(value){this._fit=value;}
  get geometry(){return first(this.node,'a:prstGeom')?.getAttribute('prst') || 'rect';}
  set geometry(value){if(value)ensure(ensure(this.node,'p:spPr'),'a:prstGeom').setAttribute('prst',value);}
  set fill(value){applyFill(ensure(this.node,'p:spPr'),value);}
  delete(){this.node.parentNode?.removeChild(this.node);this.slide.elements.delete(this.id);}
  bringToFront(){const frame=this.getFrame();this.slide.tree.appendChild(this.node);this.setFrame(frame);}
}

let slideSerial=0;
class TemplateSlide {
  constructor(presentation,doc,rels){
    this.presentation=presentation;this.doc=doc;this.rels=rels;this.uid='slide'+(++slideSerial);this.elements=new Map();
    this.tree=first(doc,'p:spTree');
    for(const node of [...descendants(this.tree,'p:sp'),...descendants(this.tree,'p:pic'),...descendants(this.tree,'p:cxnSp')]){
      const item=new TemplateElement(this,node);this.elements.set(item.id,item);
    }
    this.nextId=Math.max(1,...descendants(this.tree,'p:cNvPr').map(n=>Number(n.getAttribute('id'))))+1;
    this.shapes={add:spec=>this.addShape(spec)};
    this.images={add:spec=>this.addImage(spec)};
  }
  duplicate(){const copy=new TemplateSlide(this.presentation,parse(xml(this.doc)),parse(xml(this.rels)));this.presentation.slides.items.push(copy);return copy;}
  delete(){const items=this.presentation.slides.items;const index=items.indexOf(this);if(index>=0)items.splice(index,1);}
  moveTo(index){this.delete();this.presentation.slides.items.splice(index,0,this);}
  addShape(spec){
    const doc=this.doc,node=element(doc,'p:sp'),nv=element(doc,'p:nvSpPr');
    nv.appendChild(element(doc,'p:cNvPr',{id:this.nextId++,name:spec.name || 'Text'}));nv.appendChild(element(doc,'p:cNvSpPr'));nv.appendChild(element(doc,'p:nvPr'));node.appendChild(nv);
    const props=element(doc,'p:spPr');props.appendChild(element(doc,'a:xfrm'));props.appendChild(element(doc,'a:prstGeom',{prst:spec.geometry || 'rect'}));node.appendChild(props);
    const body=element(doc,'p:txBody');body.appendChild(element(doc,'a:bodyPr',{wrap:'none',lIns:91440,rIns:91440,tIns:0,bIns:0}));body.appendChild(element(doc,'a:lstStyle'));body.appendChild(element(doc,'a:p'));node.appendChild(body);
    this.tree.appendChild(node);const shape=new TemplateElement(this,node);this.elements.set(shape.id,shape);shape.position=spec.position;shape.fill=spec.fill;
    const line=element(doc,'a:ln',{w:Math.round((spec.line?.width || 0)*EMU)});line.appendChild(fillNode(doc,spec.line?.fill || 'none'));props.appendChild(line);
    shape.text.set('');return shape;
  }
  addImage(spec){
    const match=String(spec.dataUrl).match(/^data:(image\/[\w.+-]+);base64,([\s\S]+)$/);
    if(!match)throw new Error('Expected a base64 image');
    const bytes=Buffer.from(match[2],'base64'),extension=match[1].includes('png')?'png':'jpg';
    const media='ppt/media/generated-'+createHash('sha256').update(bytes).digest('hex')+'.'+extension;
    this.presentation.zip.file(media,bytes);
    const ids=new Set(descendants(this.rels,'Relationship').map(n=>n.getAttribute('Id')));let index=1;while(ids.has('rIdGenerated'+index))index++;
    const relId='rIdGenerated'+index,rel=element(this.rels,'Relationship',{Id:relId,Type:NS.r+'/image',Target:'../media/'+path.posix.basename(media)});this.rels.documentElement.appendChild(rel);
    const doc=this.doc,node=element(doc,'p:pic'),nv=element(doc,'p:nvPicPr');
    nv.appendChild(element(doc,'p:cNvPr',{id:this.nextId++,name:'Picture',descr:spec.alt || ''}));nv.appendChild(element(doc,'p:cNvPicPr'));nv.appendChild(element(doc,'p:nvPr'));node.appendChild(nv);
    const fill=element(doc,'p:blipFill'),blip=element(doc,'a:blip');blip.setAttributeNS(NS.r,'r:embed',relId);fill.appendChild(blip);const stretch=element(doc,'a:stretch');stretch.appendChild(element(doc,'a:fillRect'));fill.appendChild(stretch);node.appendChild(fill);
    const props=element(doc,'p:spPr');props.appendChild(element(doc,'a:xfrm'));props.appendChild(element(doc,'a:prstGeom',{prst:'rect'}));node.appendChild(props);this.tree.appendChild(node);
    const shape=new TemplateElement(this,node);this.elements.set(shape.id,shape);shape.position=spec.position;shape.crop=spec.crop;shape.fit=spec.fit || 'cover';
    this.presentation.imageJobs.push(async()=>{
      const info=await sharp(bytes).metadata(),frame=shape.frame;
      if(!info.width || !info.height)return;
      const ratio=info.width/info.height,target=frame.width/frame.height;
      if(shape.fit==='contain'){
        const width=ratio>target?frame.width:frame.height*ratio,height=width/ratio;
        shape.position={left:frame.left+(frame.width-width)/2,top:frame.top+(frame.height-height)/2,width,height};
      }else if(shape.fit!=='fill'&&!shape.crop){
        shape.crop=ratio>target?{l:Math.round((1-target/ratio)*50000),r:Math.round((1-target/ratio)*50000)}:{t:Math.round((1-ratio/target)*50000),b:Math.round((1-ratio/target)*50000)};
      }
    });
    return shape;
  }
}

export class TemplatePresentation {
  constructor(zip){this.zip=zip;this.slides={items:[]};this.imageJobs=[];}
  resolve(id){for(const slide of this.slides.items){const shape=slide.elements.get(id);if(shape)return shape;}throw new Error('PPT element not found: '+id);}
  async inspect({select}){
    const index=Number(select.match(/slides\[(\d+)\]/)?.[1]);
    const kind=select.match(/kind == '([^']+)'/)?.[1];
    const slide=this.slides.items[index];if(!slide)throw new Error('PPT slide not found: '+(index+1));
    const records=[...slide.elements.values()].filter(shape=>shape.kind===kind).map(shape=>({id:shape.id,kind:shape.kind,name:shape.name,text:shape.kind==='textbox'?shape.text.value:undefined,position:shape.frame}));
    return {records};
  }
  async writeInspection(directory){
    await fs.mkdir(directory,{recursive:true});
    for(const [index,slide] of this.slides.items.entries()){
      await fs.writeFile(path.join(directory,'slide-'+String(index+1).padStart(2,'0')+'.xml'),xml(slide.doc));
    }
  }
}

export async function openTemplate(filename){
  const zip=await JSZip.loadAsync(await fs.readFile(filename)),presentation=new TemplatePresentation(zip);
  presentation.doc=parse(await zip.file('ppt/presentation.xml').async('string'));
  presentation.rels=parse(await zip.file('ppt/_rels/presentation.xml.rels').async('string'));
  const targets=new Map(descendants(presentation.rels,'Relationship').map(n=>[n.getAttribute('Id'),n.getAttribute('Target')]));
  for(const id of descendants(presentation.doc,'p:sldId')){
    const target=targets.get(id.getAttributeNS(NS.r,'id'));
    const file=target.startsWith('/')?target.slice(1):path.posix.normalize(path.posix.join('ppt',target));
    const relFile=path.posix.join(path.posix.dirname(file),'_rels',path.posix.basename(file)+'.rels');
    const rels=zip.file(relFile)?parse(await zip.file(relFile).async('string')):parse('<Relationships xmlns="'+NS.rel+'"/>');
    presentation.slides.items.push(new TemplateSlide(presentation,parse(await zip.file(file).async('string')),rels));
  }
  return presentation;
}

export async function saveTemplate(presentation,filename){
  await Promise.all(presentation.imageJobs.map(job=>job()));
  const zip=presentation.zip,doc=presentation.doc,rels=presentation.rels;
  const list=first(doc,'p:sldIdLst');while(list.firstChild)list.removeChild(list.firstChild);
  for(const rel of descendants(rels,'Relationship'))if(rel.getAttribute('Type')===NS.r+'/slide')rel.parentNode.removeChild(rel);
  // A template's section IDs no longer refer to the duplicated slide sequence.
  for(const section of descendants(doc,'p14:sectionLst'))section.parentNode.removeChild(section);
  const types=parse(await zip.file('[Content_Types].xml').async('string'));
  for(const entry of descendants(types,'Override'))if(/^\/ppt\/slides\/slide\d+\.xml$/.test(entry.getAttribute('PartName')))entry.parentNode.removeChild(entry);
  for(const file of Object.keys(zip.files))if(/^ppt\/slides\/(?:_rels\/)?slide\d+\.xml(?:\.rels)?$/.test(file))zip.remove(file);
  for(const [index,slide] of presentation.slides.items.entries()){
    const no=index+1,id='rIdOutputSlide'+no;
    const item=element(doc,'p:sldId',{id:255+no});item.setAttributeNS(NS.r,'r:id',id);list.appendChild(item);
    rels.documentElement.appendChild(element(rels,'Relationship',{Id:id,Type:NS.r+'/slide',Target:'slides/slide'+no+'.xml'}));
    const type=types.createElementNS(NS.ct,'Override');type.setAttribute('PartName','/ppt/slides/slide'+no+'.xml');type.setAttribute('ContentType','application/vnd.openxmlformats-officedocument.presentationml.slide+xml');types.documentElement.appendChild(type);
    for(const rel of descendants(slide.rels,'Relationship'))if(rel.getAttribute('Type')===NS.r+'/notesSlide')rel.parentNode.removeChild(rel);
    zip.file('ppt/slides/slide'+no+'.xml',xml(slide.doc));zip.file('ppt/slides/_rels/slide'+no+'.xml.rels',xml(slide.rels));
  }
  for(const [ext,mime] of [['png','image/png'],['jpg','image/jpeg']])if(!descendants(types,'Default').some(n=>n.getAttribute('Extension')===ext)){
    const entry=types.createElementNS(NS.ct,'Default');entry.setAttribute('Extension',ext);entry.setAttribute('ContentType',mime);types.documentElement.appendChild(entry);
  }
  // Remove orphan notes: they otherwise retain links to the original slide IDs.
  for(const file of Object.keys(zip.files))if(/^ppt\/notesSlides\//.test(file))zip.remove(file);
  for(const entry of descendants(types,'Override'))if(/^\/ppt\/notesSlides\//.test(entry.getAttribute('PartName')))entry.parentNode.removeChild(entry);
  zip.file('ppt/presentation.xml',xml(doc));zip.file('ppt/_rels/presentation.xml.rels',xml(rels));zip.file('[Content_Types].xml',xml(types));
  if(zip.file('docProps/app.xml')){
    let app=await zip.file('docProps/app.xml').async('string');app=app.replace(/<Slides>\d+<\/Slides>/,'<Slides>'+presentation.slides.items.length+'</Slides>');zip.file('docProps/app.xml',app);
  }
  await fs.mkdir(path.dirname(filename),{recursive:true});
  await fs.writeFile(filename,await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'}));
}
