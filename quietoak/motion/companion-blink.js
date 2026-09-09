/* A short eyelid gesture; sampled by the portrait's existing animation loop. */
(function(root){
'use strict';
const smooth=x=>{x=Math.min(1,Math.max(0,x));return x*x*(3-2*x);};
class CompanionBlink {
 constructor(){this.cancel();}
 start(){this.elapsed=0;this.lastTime=null;this.progress=0;this.running=true;}
 cancel(){this.elapsed=0;this.lastTime=null;this.progress=0;this.running=false;}
 step(time){
  if(!this.running||!Number.isFinite(time)||(this.lastTime!==null&&time<this.lastTime))return this.progress;
  this.elapsed+=this.lastTime===null?0:time-this.lastTime;this.lastTime=time;
  this.progress=CompanionBlink.closure(this.elapsed);
  if(this.elapsed>=240)this.running=false;
  return this.progress;
 }
 static closure(ms){
  if(!Number.isFinite(ms)||ms<=0||ms>=240)return 0;
  if(ms<75)return smooth(ms/75);
  if(ms<100)return 1;
  return 1-smooth((ms-100)/140);
 }
}
// Reveal the authored lid from both rims, meeting at the closed-eye crease.
// No pupil crossfade: the moving lid actually covers the open eye.
function drawCompanionBlink(ctx,patch,rects,p,side,style={}){
 const {crease=.70,upperBow=.08,lowerBow=.02,edgeColor=[.314,.263,.173]}=style;
 p=Math.max(0,Math.min(1,p));if(p<=0)return;
 if(p>=1){ctx.drawImage(patch,0,0);return;}
 ctx.save();ctx.beginPath();
 for(const r of rects){
  const {x,y,width:w,height:h}=r,upper=y+h*(-.08+(crease+.08)*p),lower=y+h*(1.08-(1.08-crease)*p),bow=upperBow*h*Math.sin(Math.PI*p);
  ctx.moveTo(x-2,y-2);ctx.lineTo(x+w+2,y-2);ctx.lineTo(x+w+2,upper);
  ctx.lineTo(x+w,upper);ctx.quadraticCurveTo(x+w/2,upper+2*bow,x,upper);ctx.lineTo(x-2,upper);ctx.closePath();
  ctx.moveTo(x-2,y+h+2);ctx.lineTo(x+w+2,y+h+2);ctx.lineTo(x+w+2,lower);
  ctx.lineTo(x+w,lower);ctx.quadraticCurveTo(x+w/2,lower+2*lowerBow*h*Math.sin(Math.PI*p),x,lower);ctx.lineTo(x-2,lower);ctx.closePath();
 }
 ctx.clip();ctx.drawImage(patch,0,0);ctx.restore();
 ctx.save();ctx.beginPath();
 for(const r of rects){ctx.moveTo(r.x+r.width,r.y+r.height/2);ctx.ellipse(r.x+r.width/2,r.y+r.height/2,r.width/2,r.height/2,0,0,Math.PI*2);}
 ctx.clip();ctx.strokeStyle='rgb('+edgeColor.map(v=>Math.round(v*255)).join(',')+')';ctx.lineWidth=side*.0014;ctx.globalAlpha=.65*Math.sin(Math.PI*p);ctx.beginPath();
 for(const r of rects){const upper=r.y+r.height*(-.08+(crease+.08)*p),bow=upperBow*r.height*Math.sin(Math.PI*p);ctx.moveTo(r.x,upper);ctx.quadraticCurveTo(r.x+r.width/2,upper+2*bow,r.x+r.width,upper);}
 ctx.stroke();ctx.restore();
}
root.CompanionBlink=CompanionBlink;root.drawCompanionBlink=drawCompanionBlink;
})(typeof window!=='undefined'?window:globalThis);
