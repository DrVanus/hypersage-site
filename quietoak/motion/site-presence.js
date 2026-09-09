/* Website adapter for Quietoak's approved native/browser portrait rig.
   Artwork stays in original canvas coordinates; only actual audio drives mouths. */
(() => {
'use strict';
const N=384, feather=.0015, cache=new Map(), surfaces=[], media=matchMedia('(prefers-reduced-motion: reduce)');
const base='motion/', version='?v=20260909a';
let selected='willow', paused=false, raf=null, audioContext=null, analyser=null, waveform=null, audioID=null, audioButton=null, audioGeneration=0;
const audio=new Audio(); audio.preload='none';
const status=document.getElementById('audio-status'), motionButton=document.getElementById('motion-toggle');
const metadata=fetch(base+'face-rigs.json'+version).then(r=>{if(!r.ok)throw Error();return r.json();});
const gestures=fetch(base+'presence-rigs.json'+version).then(r=>{if(!r.ok)throw Error();return r.json();}).then(r=>r.rigs);
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
  }catch(error){if(location.hostname==='127.0.0.1')this.host.dataset.error=String(error);this.failed=true;this.host.classList.remove('presence-ready');if(this.renderer)this.renderer.destroy();}
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
function sync(){
 let running=false;
 for(const s of surfaces){
  if(s.active){s.ensure();if(s.art&&!s.failed)running=true;}
  else s.suspend(paused||media.matches||s.id!==selected&&s.host.dataset.always!=='true');
 }
 if(running&&raf===null)raf=requestAnimationFrame(tick);
 if(!running&&raf!==null){cancelAnimationFrame(raf);raf=null;}
 const unavailable=surfaces.some(s=>s.failed&&s.id===selected&&s.visible);
 for(const s of surfaces)if(s.failed&&s.host.tagName==='BUTTON'){s.host.disabled=true;s.host.setAttribute('aria-label',s.id+' animation unavailable');}
 if(motionButton){motionButton.textContent=unavailable?'Animation unavailable':media.matches?'Motion reduced':paused?'Play companion animation':'Pause companion animation';motionButton.disabled=media.matches||unavailable;motionButton.setAttribute('aria-pressed',String(paused||media.matches));}
}
function audioLevel(){
 if(!analyser||audio.paused||audio.ended||audio.readyState<2||!audioID)return 0;
 analyser.getFloatTimeDomainData(waveform);let sum=0;for(const v of waveform)sum+=v*v;
 const rms=Math.sqrt(sum/waveform.length),db=rms?20*Math.log10(rms):-Infinity;
 return db<=-50?0:Math.min(1,Math.max(0,(db+50)/32));
}
function tick(time){
 raf=null;const level=audioLevel();
 for(const s of surfaces)if(s.active&&s.art){try{s.tick(time,level);}catch(_){s.failed=true;s.host.classList.remove('presence-ready');s.suspend(false);}}
 if(surfaces.some(s=>s.active&&s.art))raf=requestAnimationFrame(tick);
 else sync();
}
function choose(id){if(audioID&&audioID!==id)stopSample();selected=id;document.querySelectorAll('.portrait-choice').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.presence===id)));sync();}
for(const host of document.querySelectorAll('[data-presence]'))surfaces.push(new Portrait(host));
const observer=new IntersectionObserver(entries=>{for(const e of entries){const s=surfaces.find(p=>p.host===e.target);s.visible=e.isIntersecting;}sync();},{threshold:.05});
surfaces.forEach(s=>observer.observe(s.host));
document.querySelectorAll('.portrait-choice').forEach(b=>{b.addEventListener('click',()=>choose(b.dataset.presence));});
if(motionButton)motionButton.addEventListener('click',()=>{paused=!paused;sync();});
media.addEventListener('change',sync);
function setAudioLabel(btn,playing){
 if(!btn)return;const name=btn.dataset.name;btn.classList.toggle('playing',playing);btn.setAttribute('aria-pressed',String(playing));
 btn.querySelector('span').textContent=playing?'Stop '+name:'Hear '+name;
 btn.setAttribute('aria-label',(playing?'Stop ':'Hear ')+name+'’s voice sample — an AI companion, not human');
}
function stopSample(){
 audioGeneration++;audio.pause();try{audio.currentTime=0;}catch(_){}setAudioLabel(audioButton,false);audioID=null;audioButton=null;if(status)status.textContent='';
 for(const s of surfaces)if(s.art)s.draw(s.blink.progress,0,s.clock.pose,s.clock.level);
}
function ensureMeter(){
 if(audioContext)return;
 const AC=window.AudioContext||window.webkitAudioContext;if(!AC)return;
 audioContext=new AC();analyser=audioContext.createAnalyser();analyser.fftSize=1024;analyser.smoothingTimeConstant=0;waveform=new Float32Array(analyser.fftSize);
 const source=audioContext.createMediaElementSource(audio);source.connect(analyser);analyser.connect(audioContext.destination);
}
document.querySelectorAll('.comp-hear').forEach(btn=>{
 btn.setAttribute('aria-pressed','false');
 btn.addEventListener('click',async()=>{
  if(audioButton===btn){stopSample();status.textContent='';return;}
  stopSample();const g=document.getElementById('guided-audio');if(g)g.pause();
  const id=btn.dataset.companion;choose(id);audioID=id;audioButton=btn;const generation=audioGeneration;
  status.textContent='Loading '+btn.dataset.name+'’s voice…';audio.src=btn.dataset.audio;
  try{ensureMeter();if(audioContext)await audioContext.resume();if(generation!==audioGeneration)return;await audio.play();if(generation!==audioGeneration)return;}
  catch(_){if(generation!==audioGeneration)return;stopSample();status.textContent='The voice sample could not play. Please try again.';}
 });
});
audio.addEventListener('playing',()=>{if(!audioID||audio.paused)return;setAudioLabel(audioButton,true);status.textContent=audioButton?'Playing '+audioButton.dataset.name+'’s recorded voice.':'';sync();});
audio.addEventListener('ended',()=>{stopSample();status.textContent='';});
audio.addEventListener('error',()=>{if(audioButton){stopSample();status.textContent='The voice sample could not load. Please try again.';}});
const guided=document.getElementById('guided-audio'),gb=document.getElementById('guided-play'),gf=document.getElementById('guided-fill'),gt=document.getElementById('guided-time');
if(guided&&gb){
 const fmt=s=>Math.floor(Math.max(0,s)/60)+':'+String(Math.ceil(Math.max(0,s))%60).padStart(2,'0');
 const state=()=>{const playing=!guided.paused&&!guided.ended;gb.classList.toggle('playing',playing);gb.setAttribute('aria-pressed',String(playing));gb.setAttribute('aria-label',(playing?'Pause':'Play')+' the body scan opening, read by Willow, an AI companion, not human');};
 gb.addEventListener('click',()=>{if(guided.paused){stopSample();guided.play().catch(()=>{status.textContent='The guided sample could not play. Please try again.';});}else guided.pause();});
 guided.addEventListener('play',state);guided.addEventListener('pause',state);guided.addEventListener('ended',()=>{state();gf.style.width='0%';gt.textContent=fmt(guided.duration||17);});
 guided.addEventListener('timeupdate',()=>{if(guided.duration){gf.style.width=(guided.currentTime/guided.duration*100)+'%';gt.textContent=fmt(guided.duration-guided.currentTime);}});
 state();
}
document.addEventListener('visibilitychange',()=>{if(document.hidden){stopSample();if(guided)guided.pause();}sync();});
window.addEventListener('pagehide',()=>{stopSample();if(guided)guided.pause();if(raf!==null)cancelAnimationFrame(raf);raf=null;for(const s of surfaces)s.clock.pause();});
window.addEventListener('pageshow',sync);
sync();
})();
