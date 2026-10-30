/* Website adapter for Quietoak's approved native/browser portrait rig.
   Artwork stays in original canvas coordinates; only actual audio drives mouths. */
(() => {
'use strict';
const N=384, feather=.0015, cache=new Map(), surfaces=[];
const media=typeof matchMedia==='function'?matchMedia('(prefers-reduced-motion: reduce)'):{matches:false};
const base='motion/', version='?v=20260909a';
let selected='willow', paused=false, raf=null, audioContext=null, analyser=null, waveform=null, audioID=null, audioButton=null, audioGeneration=0, meterPending=null;
// Media remains usable when the optional portrait or Web Audio helpers fail.
let audio=null;try{audio=new Audio();audio.preload='none';}catch(_){}
const status=document.getElementById('audio-status'), motionButton=document.getElementById('motion-toggle');
const getJSON=url=>Promise.resolve().then(()=>fetch(url)).then(r=>{if(!r.ok)throw Error('Portrait metadata unavailable');return r.json();});
const metadata=getJSON(base+'face-rigs.json'+version);
const gestures=getJSON(base+'presence-rigs.json'+version).then(r=>r.rigs);
// Handled below by each asset load; keep failed metadata from rejecting unobserved.
metadata.catch(()=>{}); gestures.catch(()=>{});
const torsos={
 willow:{center:[.44,.64],radius:[.2,.115],rise:.009,expansion:.11},
 sage:{center:[.5,.66],radius:[.46,.17],rise:.008,expansion:.1},
 river:{center:[.49,.61],radius:[.33,.16],rise:.009,expansion:.1},
 sol:{center:[.49,.67],radius:[.235,.125],rise:.009,expansion:.1},
 stone:{center:[.31,.65],radius:[.23,.085],rise:.006,expansion:.085},
 fern:{center:[.52,.68],radius:[.235,.1],rise:.009,expansion:.1}
};
const makeCanvas=()=>{const c=document.createElement('canvas');c.width=c.height=N;return c;};
const loadImage=name=>new Promise((resolve,reject)=>{const i=new Image();i.onload=()=>resolve(i);i.onerror=reject;i.src=base+'art/'+name+'.webp'+version;});
function fittedCanvas(rig){
 const scale=N/Math.max(rig.canvas.width,rig.canvas.height);
 return {scale,x:(N-rig.canvas.width*scale)/2,y:(N-rig.canvas.height*scale)/2,width:rig.canvas.width*scale,height:rig.canvas.height*scale};
}
function maskedPatch(image,rectangles,rig){
 const layer=document.createElement('canvas');layer.width=layer.height=N;
 const fit=fittedCanvas(rig),lc=layer.getContext('2d');
 // Registration maps native expression pixels into native resting-image pixels.
 // Contain-fit both through that same coordinate space; never stretch the art.
 lc.save();lc.translate(fit.x,fit.y);lc.scale(fit.scale,fit.scale);lc.transform(...rig.transform);
 lc.drawImage(image,0,0,rig.expression.width,rig.expression.height);lc.restore();
 if(!rectangles)return layer;
 const mask=document.createElement('canvas');mask.width=mask.height=N;
 const mc=mask.getContext('2d');mc.fillStyle='white';mc.filter='blur('+(N*feather)+'px)';
 rectangles.forEach(r=>{mc.beginPath();mc.ellipse(fit.x+(r.x+r.width/2)*fit.width,fit.y+(r.y+r.height/2)*fit.height,r.width*fit.width/2,r.height*fit.height/2,0,0,Math.PI*2);mc.fill();});
 lc.globalCompositeOperation='destination-in';lc.drawImage(mask,0,0);return layer;
}

function prepareRest(base,rig){
 const rest=document.createElement('canvas');rest.width=rest.height=N;
 const fit=fittedCanvas(rig),rc=rest.getContext('2d');rc.imageSmoothingQuality='high';
 rc.drawImage(base,fit.x,fit.y,fit.width,fit.height);return rest;
}
function fitTorso(id,rig,gestures){
 const fit=fittedCanvas(rig),r=torsos[id];
 const point=p=>[(fit.x+p[0]*fit.width)/N,(fit.y+p[1]*fit.height)/N];
 const xBand=p=>p.map(v=>(fit.x+v*fit.width)/N),yBand=p=>p.map(v=>(fit.y+v*fit.height)/N);
 const h=gestures?.head,t=gestures?.tail;
 const head=h?{...h,pivot:point(h.pivot),neckBand:yBand(h.neckBand),xFade:h.xFade?xBand(h.xFade):[2,3],maxBob:h.maxBob*fit.height/N}:null;
 const tail=t?{...t,pivot:point(t.pivot),tip:point(t.tip),center:point(t.center),radius:[t.radius[0]*fit.width/N,t.radius[1]*fit.height/N],clipX:t.clipX?xBand(t.clipX):[-2,-1],maxTipOffset:t.maxTipOffset*fit.height/N}:null;
 if(tail&&t.hinge){const v=t.hinge;tail.hinge={...v,pivot:point(v.pivot),feather:v.feather*fit.width/N,boundary:v.boundary.map(([y,x])=>[(fit.y+y*fit.height)/N,(fit.x+x*fit.width)/N])};}
 return {...r,center:point(r.center),radius:[r.radius[0]*fit.width/N,r.radius[1]*fit.height/N],rise:r.rise*fit.height/N,head,tail};
}
async function loadArt(id){
 if(!cache.has(id)) cache.set(id,(async()=>{
  const [baseImage,expression,rigs,presence]=await Promise.all([loadImage(id+'-dimensional'),loadImage(id+'-expression'),metadata,gestures]);
  const rig=rigs[id], fit=fittedCanvas(rig);
  let eyes=maskedPatch(expression,rig.eyes,rig), mouth=maskedPatch(expression,[rig.mouth],rig), raw=maskedPatch(expression,null,rig);
  if(rig.blinkVariant){const v=rig.blinkVariant;eyes=maskedPatch(await loadImage(v.asset),rig.eyes,{...rig,...v});}
  if(rig.loudMouth){const v=rig.loudMouth, im=await loadImage(v.asset);mouth=maskedPatch(im,[rig.mouth],{...rig,...v});raw=maskedPatch(im,null,{...rig,...v});}
  return {rig,rest:prepareRest(baseImage,rig),eyes,mouth,config:fitTorso(id,rig,presence[id]),
   aperture:CompanionMouthAperture.create(raw,rig,fit,N),
   eyeRects:rig.eyes.map(r=>({x:fit.x+r.x*fit.width,y:fit.y+r.y*fit.height,width:r.width*fit.width,height:r.height*fit.height}))};
 })());
 return cache.get(id);
}
class Portrait {
 constructor(host){
  this.host=host;this.id=host.dataset.presence;this.visible=false;this.art=null;this.loading=false;this.failed=false;
  this.canvas=makeCanvas();this.canvas.setAttribute('aria-hidden','true');this.canvas.className='presence-canvas';this.ctx=this.canvas.getContext('2d');this.ctx.imageSmoothingQuality='high';
  this.composite=makeCanvas();this.cc=this.composite.getContext('2d');this.key='';
  this.clock=new PresenceMotion();this.clock.setContext(this.id);this.blink=new CompanionBlink();this.nextBlink=1400+surfaces.length*430;
  host.append(this.canvas);
 }
 get active(){return this.visible&&!document.hidden&&!paused&&!media.matches&&!this.failed&&(this.host.dataset.always==='true'||this.id===selected);}
 async ensure(){
  if(this.loading||this.art||this.failed)return;
  this.loading=true;
  try{
   this.art=await loadArt(this.id);
   this.renderer=CompanionTorsoRenderer.create(N,()=>{this.failed=true;this.host.classList.remove('presence-ready');sync();});
   if(!this.renderer.available)throw Error('Renderer unavailable');
   if(!this.renderer.setArt(this.art.rest,this.art.config))throw Error('Rig unavailable');
   this.draw(0,0,{head:0,tail:0,lift:0});this.host.classList.add('presence-ready');
  }catch(error){if(location.hostname==='127.0.0.1')this.host.dataset.error=String(error);this.failed=true;this.host.classList.remove('presence-ready');try{if(this.renderer)this.renderer.destroy();}catch(_){}}
  this.loading=false;sync();
 }
 draw(eyes=0,mouth=0,pose={head:0,tail:0,lift:0},breath=0){
  if(!this.art||!this.renderer||!this.renderer.available)return;
  this.atRest=eyes===0&&mouth===0&&breath===0&&pose.head===0&&pose.tail===0&&pose.lift===0;
  const key=eyes+':'+mouth;
  if(key!==this.key){
   this.key=key;this.cc.clearRect(0,0,N,N);this.cc.globalAlpha=1;this.cc.drawImage(this.art.rest,0,0);
   if(eyes>0)drawCompanionBlink(this.cc,this.art.eyes,this.art.eyeRects,eyes,N,this.art.rig.blinkStyle);
   if(mouth>0){if(this.art.aperture)this.art.aperture.draw(this.cc,mouth);else{this.cc.globalAlpha=mouth;this.cc.drawImage(this.art.mouth,0,0);this.cc.globalAlpha=1;}}
   this.renderer.updateArt(this.composite);
  }
  this.ctx.clearRect(0,0,N,N);this.ctx.drawImage(this.renderer.render(breath,pose)||this.composite,0,0);
  // Render state is attached to the corresponding visible element for local QA.
  if(location.hostname==='127.0.0.1'||location.hostname==='localhost'){
   this.host.dataset.pose=JSON.stringify({breath,eyes,mouth,head:pose.head,time:this.clock.activeElapsed});
  }
 }
 tick(time,level){
  const breath=this.clock.step(time,true), elapsed=this.clock.activeElapsed;
  if(!this.blink.running&&elapsed>=this.nextBlink){this.blink.start();this.nextBlink=elapsed+4000+Math.random()*2200;}
  this.blink.step(elapsed);
  this.draw(this.blink.progress,this.id===audioID?level:0,this.clock.pose,breath);
 }
 suspend(rest){this.clock.pause();if(rest){this.clock.reduce();this.blink.cancel();if(!this.atRest)this.draw();}}
}
// Renderer failures retire only that decorative surface; the original image stays.
let portraitSetupFailed=false;
function failPortrait(s){
 s.failed=true;s.host.classList.remove('presence-ready');
 try{s.clock.pause();}catch(_){}
 try{if(s.renderer)s.renderer.destroy();}catch(_){}
}
function sync(){
 let running=false;
 for(const s of surfaces){
  try{
   if(s.active){s.ensure();if(s.art&&!s.failed)running=true;}
   else s.suspend(paused||media.matches||s.id!==selected&&s.host.dataset.always!=='true');
  }catch(_){failPortrait(s);}
 }
 if(running&&raf===null)raf=requestAnimationFrame(tick);
 if(!running&&raf!==null){cancelAnimationFrame(raf);raf=null;}
 const unavailable=portraitSetupFailed||surfaces.some(s=>s.failed&&s.id===selected&&s.visible);
 for(const s of surfaces)if(s.failed&&s.host.tagName==='BUTTON'){s.host.disabled=true;s.host.setAttribute('aria-label',s.id+' animation unavailable');}
 if(motionButton){motionButton.textContent=unavailable?'Animation unavailable':media.matches?'Motion reduced':paused?'Play companion animation':'Pause companion animation';motionButton.disabled=media.matches||unavailable;motionButton.setAttribute('aria-pressed',String(paused||media.matches));}
}
function audioLevel(){
 if(!audio||!analyser||audio.paused||audio.ended||audio.readyState<2||!audioID)return 0;
 try{
  analyser.getFloatTimeDomainData(waveform);let sum=0;for(const v of waveform)sum+=v*v;
  const rms=Math.sqrt(sum/waveform.length),db=rms?20*Math.log10(rms):-Infinity;
  return Number.isFinite(db)&&db>-50?Math.min(1,Math.max(0,(db+50)/32)):0;
 }catch(_){return 0;}
}
function tick(time){
 raf=null;const level=audioLevel();
 for(const s of surfaces)if(s.active&&s.art){try{s.tick(time,level);}catch(_){failPortrait(s);}}
 if(surfaces.some(s=>s.active&&s.art))raf=requestAnimationFrame(tick);
 else sync();
}
function choose(id){if(audioID&&audioID!==id)stopSample();selected=id;document.querySelectorAll('.portrait-choice').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.presence===id)));sync();}
for(const host of document.querySelectorAll('[data-presence]')){
 try{surfaces.push(new Portrait(host));}
 catch(_){portraitSetupFailed=true;host.classList.remove('presence-ready');if(host.tagName==='BUTTON'){host.disabled=true;host.setAttribute('aria-label',host.dataset.presence+' animation unavailable');}}
}
try{
 if(typeof IntersectionObserver!=='function'||typeof requestAnimationFrame!=='function')throw Error('Animation observation unavailable');
 const observer=new IntersectionObserver(entries=>{for(const e of entries){const s=surfaces.find(p=>p.host===e.target);if(s)s.visible=e.isIntersecting;}sync();},{threshold:.05});
 surfaces.forEach(s=>observer.observe(s.host));
}catch(_){portraitSetupFailed=true;surfaces.forEach(failPortrait);}
document.querySelectorAll('.portrait-choice').forEach(b=>{b.addEventListener('click',()=>choose(b.dataset.presence));});
if(motionButton)motionButton.addEventListener('click',()=>{paused=!paused;sync();});
if(media.addEventListener)media.addEventListener('change',sync);else if(media.addListener)media.addListener(sync);
function setStatus(text){if(status)status.textContent=text;}
function setAudioLabel(btn,playing){
 if(!btn)return;const name=btn.dataset.name;btn.classList.toggle('playing',playing);btn.setAttribute('aria-pressed',String(playing));
 const label=btn.querySelector('span');if(label)label.textContent=playing?'Stop '+name:'Hear '+name;
 btn.setAttribute('aria-label',(playing?'Stop ':'Hear ')+name+'’s voice sample — an AI companion, not human');
}
function closeMouths(){
 for(const s of surfaces)if(s.art&&!s.failed){try{s.draw(s.blink.progress,0,s.clock.pose,s.clock.level);}catch(_){failPortrait(s);}}
}
function stopSample(){
 audioGeneration++;const button=audioButton;audioID=null;audioButton=null;
 if(audio){audio.pause();try{audio.currentTime=0;}catch(_){}}
 setAudioLabel(button,false);setStatus('');closeMouths();
}
function ensureMeter(){
 if(!meterPending)meterPending=configureMeter().finally(()=>{meterPending=null;});
 return meterPending;
}
async function configureMeter(){
 if(audioContext){try{await audioContext.resume();}catch(_){}return;}
 const AC=window.AudioContext||window.webkitAudioContext;if(!AC||!audio)return;
 let context,source;
 try{
  context=new AC();await context.resume();
  // Do not route native media into a context that could not start.
  if(context.state&&context.state!=='running'){try{await context.close();}catch(_){}return;}
  const meter=context.createAnalyser();meter.fftSize=1024;meter.smoothingTimeConstant=0;
  source=context.createMediaElementSource(audio);source.connect(meter);meter.connect(context.destination);
  audioContext=context;analyser=meter;waveform=new Float32Array(meter.fftSize);
 }catch(_){
  // If routing partly succeeded, retain a direct output without portrait metering.
  if(source){try{source.disconnect();source.connect(context.destination);audioContext=context;}catch(_){} }
  else if(context){try{await context.close();}catch(_){} }
 }
}
const guided=document.getElementById('guided-audio'),gb=document.getElementById('guided-play'),gf=document.getElementById('guided-fill'),gt=document.getElementById('guided-time');
const gs=document.getElementById('guided-status'),gl=document.getElementById('guided-play-label');
const grow=gb?gb.closest('.gp-row'):null;
let guidedGeneration=0,guidedState='ready';
function pauseGuided(){guidedGeneration++;if(guided)guided.pause();}
if(audio){
 document.querySelectorAll('.comp-hear').forEach(btn=>{
  btn.setAttribute('role','button');btn.setAttribute('aria-pressed','false');
  btn.addEventListener('keydown',event=>{if((event.key===' '||event.key==='Spacebar')&&!event.altKey&&!event.ctrlKey&&!event.metaKey&&!event.shiftKey){event.preventDefault();if(!event.repeat)btn.click();}});
  btn.addEventListener('click',async event=>{
   // Keep normal link behavior for open-in-new-tab and other modified clicks.
   if(event.defaultPrevented||event.altKey||event.ctrlKey||event.metaKey||event.shiftKey||event.button>0)return;
   event.preventDefault();
   if(audioButton===btn){stopSample();return;}
   stopSample();pauseGuided();
   const id=btn.dataset.companion;choose(id);audioID=id;audioButton=btn;const generation=audioGeneration;
   setStatus('Loading '+btn.dataset.name+'’s voice…');audio.src=btn.dataset.audio||btn.href;
   try{await ensureMeter();if(generation!==audioGeneration)return;await audio.play();if(generation!==audioGeneration)return;}
   catch(_){if(generation!==audioGeneration)return;stopSample();setStatus('The voice sample could not play. Please try again.');}
  });
 });
 audio.addEventListener('playing',()=>{if(!audioID||audio.paused)return;setAudioLabel(audioButton,true);setStatus(audioButton?'Playing '+audioButton.dataset.name+'’s recorded voice.':'');sync();});
 audio.addEventListener('pause',()=>{if(audio.paused&&audioButton){stopSample();setStatus('Voice sample paused.');}});
 audio.addEventListener('waiting',()=>{if(audioButton&&!audio.paused){setAudioLabel(audioButton,false);setStatus('Loading '+audioButton.dataset.name+'’s voice…');closeMouths();}});
 audio.addEventListener('ended',()=>{stopSample();});
 audio.addEventListener('error',()=>{if(audioButton){stopSample();setStatus('The voice sample could not load. Please try again.');}});
}
if(guided){
 // Applies to native controls too if custom-control enhancement is unavailable.
 guided.addEventListener('play',()=>{stopSample();});
}
if(guided&&gb&&grow){
 const fmt=value=>{const total=Math.ceil(Number.isFinite(value)?Math.max(0,value):0);return Math.floor(total/60)+':'+String(total%60).padStart(2,'0');};
 const time=()=>{
  const duration=guided.duration,current=guided.currentTime;
  if(!Number.isFinite(duration)||duration<=0)return;
  if(gf)gf.style.width=(guided.ended?0:Math.min(100,Math.max(0,current/duration*100)))+'%';
  if(gt)gt.textContent=fmt(guided.ended?duration:duration-current);
 };
 const state=(next,message)=>{
  guidedState=next;const playing=next==='playing';
  gb.classList.toggle('playing',playing);gb.setAttribute('aria-pressed',String(playing));
  const label=next==='loading'?'Cancel loading':playing?'Pause sample':next==='ended'?'Replay sample':next==='paused'?'Resume sample':next==='error'?'Try again':'Play sample';
  if(gl)gl.textContent=label;
  gb.setAttribute('aria-label',label+' — the body scan opening, read by Willow, an AI companion, not human');
  if(gs)gs.textContent=message||'';
 };
 gb.addEventListener('click',async()=>{
  if(guidedState==='loading'||!guided.paused&&!guided.ended){pauseGuided();state('paused','Paused. You can resume the sample.');return;}
  stopSample();const generation=++guidedGeneration;
  if(guided.ended){try{guided.currentTime=0;}catch(_){}}
  state('loading','Loading Willow’s body scan opening…');
  try{if(guided.error)guided.load();await guided.play();}
  catch(_){if(generation!==guidedGeneration)return;pauseGuided();state('error','The guided sample could not play. Please try again.');}
 });
 guided.addEventListener('play',()=>{state('loading','Loading Willow’s body scan opening…');});
 guided.addEventListener('playing',()=>{if(!guided.paused&&!guided.ended)state('playing','Playing Willow’s recorded body scan opening.');});
 guided.addEventListener('waiting',()=>{if(!guided.paused)state('loading','Loading Willow’s body scan opening…');});
 guided.addEventListener('pause',()=>{if(!guided.paused)return;guidedGeneration++;if(!guided.ended&&guidedState!=='error'){state('paused','Paused. You can resume the sample.');time();}});
 guided.addEventListener('ended',()=>{guidedGeneration++;state('ended','Sample complete. You can play it again.');time();});
 guided.addEventListener('error',()=>{pauseGuided();state('error','The guided sample could not load. Please try again.');});
 guided.addEventListener('loadedmetadata',time);guided.addEventListener('durationchange',time);guided.addEventListener('timeupdate',time);
 state('ready','');time();
 // Reveal custom controls only after every listener is bound. With no script,
 // or missing markup, the original native audio controls remain available.
 grow.hidden=false;guided.controls=false;guided.hidden=true;
}
document.addEventListener('visibilitychange',()=>{if(document.hidden){stopSample();pauseGuided();}sync();});
window.addEventListener('pagehide',()=>{stopSample();pauseGuided();if(raf!==null)cancelAnimationFrame(raf);raf=null;for(const s of surfaces){try{s.clock.pause();}catch(_){}}});
window.addEventListener('pageshow',sync);
sync();
})();
