/* Fit the opening to paired lip contours. Source artwork stays untouched. */
(function(root){
'use strict';
const smooth=t=>{t=Math.min(1,Math.max(0,t));return t*t*(3-2*t);};
function valid(r){return r&&['smooth','linear'].includes(r.interpolation)&&Number.isFinite(r.exponent)&&r.exponent>0&&Number.isFinite(r.lipRing)&&r.lipRing>=0&&r.lipRing<=.01&&Array.isArray(r.points)&&r.points.length>=3&&r.points.every((p,i)=>Array.isArray(p)&&p.length===4&&p.every(v=>Number.isFinite(v)&&v>=0&&v<=1)&&p[2]>p[1]&&(!i||p[0]>r.points[i-1][0]));}
function create(source,rig,fit,side){
 const config=rig.mouthAperture;if(!valid(config))return null;
 const pts=config.points.map(p=>[fit.x+p[0]*fit.width,...p.slice(1).map(y=>fit.y+y*fit.height)]);
 const m=rig.mouth,rect={x:fit.x+m.x*fit.width,y:fit.y+m.y*fit.height,width:m.width*fit.width,height:m.height*fit.height};
 if(pts[0][0]<=rect.x||pts.at(-1)[0]>=rect.x+rect.width||pts.some(p=>p.slice(1).some(y=>y<=rect.y||y>=rect.y+rect.height)))return null;
 const make=()=>{const c=document.createElement('canvas');c.width=c.height=side;return c;};
 const warp=make(),oral=make(),mask=make(),ellipse=make(),wc=warp.getContext('2d'),oc=oral.getContext('2d'),mc=mask.getContext('2d'),ec=ellipse.getContext('2d');
 ec.filter='blur('+(side*.0015)+'px)';ec.fillStyle='white';ec.beginPath();ec.ellipse(rect.x+rect.width/2,rect.y+rect.height/2,rect.width/2,rect.height/2,0,0,Math.PI*2);ec.fill();
 let cached=-1;
 function sample(x){
  let n=0;while(n<pts.length-2&&x>pts[n+1][0])n++;
  const left=pts[n],right=pts[n+1],t=Math.min(1,Math.max(0,(x-left[0])/(right[0]-left[0])));
  const values=[1,2,3].map(k=>{
   if(config.interpolation==='linear')return left[k]+(right[k]-left[k])*t;
   const p0=pts[Math.max(0,n-1)][k],p1=left[k],p2=right[k],p3=pts[Math.min(pts.length-1,n+2)][k];
   return .5*(2*p1+(-p0+p2)*t+(2*p0-5*p1+4*p2-p3)*t*t+(-p0+3*p1-3*p2+p3)*t*t*t);
  });
  values[0]=Math.max(rect.y+.01,Math.min(rect.y+rect.height-.02,values[0]));
  values[1]=Math.max(values[0]+.01,Math.min(rect.y+rect.height-.01,values[1]));return values;
 }
 function rebuild(p){
  cached=p;wc.globalCompositeOperation='source-over';wc.clearRect(0,0,side,side);wc.imageSmoothingQuality='high';
  if(p>=1){wc.drawImage(source,0,0);wc.globalCompositeOperation='destination-in';wc.drawImage(ellipse,0,0);oc.globalCompositeOperation='source-over';oc.clearRect(0,0,side,side);return;}
  wc.drawImage(source,0,0);wc.clearRect(Math.floor(rect.x),rect.y,Math.ceil(rect.x+rect.width)-Math.floor(rect.x),rect.height);
  const amount=Math.pow(p,config.exponent),width=1,outline=[];
  // Integer backing-pixel columns avoid translucent seams from fractional
  // drawImage edges, especially inside narrow mouths such as River’s.
  for(let x=Math.floor(rect.x);x<Math.ceil(rect.x+rect.width);x++){
   const mid=x+width/2,[top,bottom,rest]=sample(mid);
   const weight=smooth((mid-rect.x)/(pts[0][0]-rect.x))*(1-smooth((mid-pts.at(-1)[0])/(rect.x+rect.width-pts.at(-1)[0])));
   const mix=1-(1-amount)*weight,dTop=rest+(top-rest)*mix,dBottom=rest+(bottom-rest)*mix;
   wc.drawImage(source,x,rect.y,width,top-rect.y,x,rect.y,width,dTop-rect.y);
   wc.drawImage(source,x,top,width,bottom-top,x,dTop,width,dBottom-dTop);
   wc.drawImage(source,x,bottom,width,rect.y+rect.height-bottom,x,dBottom,width,rect.y+rect.height-dBottom);
   if(mid>=pts[0][0]&&mid<=pts.at(-1)[0])outline.push([mid,dTop,dBottom]);
  }
  wc.globalCompositeOperation='destination-in';wc.drawImage(ellipse,0,0);
  mc.clearRect(0,0,side,side);mc.filter='blur('+(side*.0013)+'px)';mc.fillStyle='white';mc.beginPath();
  const pad=config.lipRing*fit.height;
  outline.forEach(([x,y],i)=>i?mc.lineTo(x,y-pad):mc.moveTo(x,y-pad));
  outline.slice().reverse().forEach(([x,y,bottom])=>mc.lineTo(x,bottom+pad));mc.closePath();mc.fill();
  oc.globalCompositeOperation='source-over';oc.clearRect(0,0,side,side);oc.drawImage(warp,0,0);oc.globalCompositeOperation='destination-in';oc.drawImage(mask,0,0);
 }
 return {draw(ctx,value){const p=Math.min(1,Math.max(0,Number(value)||0));if(p<=0)return;
  if(p!==cached)rebuild(p);
  ctx.save();ctx.globalAlpha=p*p;ctx.drawImage(warp,0,0);ctx.globalAlpha=Math.min(1,p/.08);ctx.drawImage(oral,0,0);ctx.restore();
 }};
}
root.CompanionMouthAperture={create,valid};
})(typeof window!=='undefined'?window:globalThis);
