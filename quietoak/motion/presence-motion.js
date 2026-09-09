/* A single display-clock phase, independent of speech and blink events. */
(function(root){
'use strict';
class PresenceMotion {
 constructor(period=7200){this.period=period;this.reset();}
 reset(){this.attentionMix=0;this.listening=false;this.companionID='';this.elapsed=0;this.activeElapsed=0;this.gain=0;this.lastTime=null;}
 pause(){this.lastTime=null;}
 reduce(){this.gain=0;this.lastTime=null;this.attentionMix=0;}
 setContext(companionID,listening=false){if(this.companionID!==companionID)this.attentionMix=0;this.companionID=companionID;this.listening=listening;}
 step(time,enabled){
  if(!Number.isFinite(time))return this.level;
  const delta=this.lastTime===null?0:Math.min(64,Math.max(0,time-this.lastTime));
  this.lastTime=time;
  this.elapsed=(this.elapsed+delta)%this.period;this.activeElapsed+=delta;
  const attention=this.listening?1:0;this.attentionMix=attention+(this.attentionMix-attention)*Math.exp(-delta/450);
  const target=enabled?1:0;
  this.gain=target+(this.gain-target)*Math.exp(-delta/180);
  if(Math.abs(this.gain-target)<.001)this.gain=target;
  return this.level;
 }
 get level(){
  const inhale=this.period*(3/7.2);
  const wave=this.elapsed<inhale?(1-Math.cos(Math.PI*this.elapsed/inhale))/2:
   (1+Math.cos(Math.PI*(this.elapsed-inhale)/(this.period-inhale)))/2;
  return this.gain*wave;
 }
 get pose(){
  const t=this.activeElapsed/1000,u=(t%11.2-1)/3.2,headU=(t%16-4)/4.2;
  const head=headU>0&&headU<1?Math.sin(Math.PI*headU)**2*(Math.floor(t/16)%2===0?1:-1):0;
  const baseHead=this.companionID==='sage'?(.72*Math.sin(2*Math.PI*t/12.8)+.28*Math.sin(2*Math.PI*t/8.3)):head;
  return {head:this.gain*((1-this.attentionMix)*baseHead-.18*this.attentionMix),
   tail:u>0&&u<1?this.gain*Math.sin(4*Math.PI*u)*Math.sin(Math.PI*u)**2*(1-.8*this.attentionMix):0,lift:this.level*(1-.35*this.attentionMix)};
 }
 get settling(){return this.gain>0;}
}
if(typeof module!=='undefined'&&module.exports)module.exports=PresenceMotion;
else root.PresenceMotion=PresenceMotion;
})(typeof window!=='undefined'?window:globalThis);
