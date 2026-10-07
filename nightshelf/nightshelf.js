(() => {
'use strict';
const gallery = document.querySelector('.screen-gallery');
const previous = document.querySelector('.gallery-prev');
const next = document.querySelector('.gallery-next');
if (gallery && previous && next) {
 const update = () => { previous.disabled = gallery.scrollLeft < 4; next.disabled = gallery.scrollLeft + gallery.clientWidth >= gallery.scrollWidth - 4; };
 const move = direction => gallery.scrollBy({left: direction * (gallery.querySelector('.screen-card').offsetWidth + parseFloat(getComputedStyle(gallery).gap)), behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'});
 previous.addEventListener('click', () => move(-1)); next.addEventListener('click', () => move(1));
 gallery.addEventListener('scroll', update, {passive:true}); window.addEventListener('resize', update); update();
}
const narr = document.getElementById('listen-audio');
const room = document.getElementById('ambient-audio');
if (!narr || !room) return;
const voiceButtons = [...document.querySelectorAll('.voice-option')];
const soundButtons = [...document.querySelectorAll('.sound-tile')];
const status = document.getElementById('audio-status');
const stop = document.getElementById('stop-preview');
const toggle = document.getElementById('room-toggle');
const volume = document.getElementById('room-volume');
const roomNow = document.getElementById('room-now');
let activeVoice = null, activeSound = null, voiceRequest = 0, soundRequest = 0;
let audioContext, roomFade, roomGain, roomSource;
narr.defaultPlaybackRate = .85; narr.playbackRate = .85;
narr.preservesPitch = true; narr.webkitPreservesPitch = true;
const playing = audio => !audio.paused && !audio.ended;
const format = seconds => {const value = Math.max(0, Math.ceil(seconds)); return Math.floor(value/60)+':'+String(value%60).padStart(2,'0');};
function announce(message, isError=false) {status.textContent=message;status.dataset.error=String(isError);}
function setupMix() {
 if (audioContext) {audioContext.resume().catch(()=>{});return;}
 const AudioContextClass = window.AudioContext || window.webkitAudioContext;
 if (!AudioContextClass) return;
 try {
  audioContext = new AudioContextClass();
  roomSource = audioContext.createMediaElementSource(room);
  roomFade = audioContext.createGain(); roomGain = audioContext.createGain();
  roomSource.connect(roomFade).connect(roomGain).connect(audioContext.destination);
  room.volume=1; // The graph owns volume once connected; avoid applying it twice.
  roomFade.gain.value=0; roomGain.gain.value=Number(volume.value)/100;
  audioContext.resume().catch(()=>{});
 } catch (_) {audioContext=null;roomFade=null;roomGain=null;}
}
function mixLevel() {
 const target = Number(volume.value)/100 * (playing(narr) ? .70 : 1);
 if(roomGain && audioContext) {
  roomGain.gain.cancelScheduledValues(audioContext.currentTime);
  roomGain.gain.setTargetAtTime(target,audioContext.currentTime,.08);
 } else room.volume=target;
}
function openingFade() {
 mixLevel();
 if(roomFade && audioContext) {
  const now=audioContext.currentTime;
  roomFade.gain.cancelScheduledValues(now);roomFade.gain.setValueAtTime(0,now);
  roomFade.gain.linearRampToValueAtTime(1,now+2.5);
 }
}
function update() {
 const voicePlaying=playing(narr), soundPlaying=playing(room);
 voiceButtons.forEach(button=>{
  const on=button===activeVoice && voicePlaying;
  button.classList.toggle('playing',on);button.setAttribute('aria-pressed',String(on));
  button.setAttribute('aria-label',(on?'Pause ':'Play ')+button.dataset.name+' narrator preview');
  button.querySelector('.voice-state').textContent=on?'Pause':'Play';
 });
 soundButtons.forEach(button=>{
  const selected=button===activeSound, on=selected&&soundPlaying;
  button.classList.toggle('selected',selected);button.classList.toggle('playing',on);
  button.setAttribute('aria-pressed',String(selected));
  button.setAttribute('aria-label',(on?'Pause ':'Play ')+button.dataset.name+' preview');
 });
 toggle.disabled=!activeSound;
 toggle.textContent=soundPlaying?'Pause sound':'Play sound';
 toggle.setAttribute('aria-label',(soundPlaying?'Pause ':'Play ')+(activeSound?activeSound.dataset.name:'background sound'));
 roomNow.textContent=activeSound ? activeSound.dataset.name+(soundPlaying?' · Playing':' · Paused') : 'Sound off';
 stop.disabled=!voicePlaying&&!soundPlaying;
 mixLevel();
}
function describe() {
 const voicePlaying=playing(narr), soundPlaying=playing(room);
 if(voicePlaying&&soundPlaying) announce(activeVoice.dataset.name+' with '+activeSound.dataset.name+'.');
 else if(voicePlaying) announce('Playing '+activeVoice.dataset.name+'.');
 else if(soundPlaying) announce('Playing '+activeSound.dataset.name+'. Add a narrator to hear them together.');
 else announce('Previews paused.');
}
function begin(audio) {
 setupMix();
 const token=audio===narr?++voiceRequest:++soundRequest;
 if(audio===narr){audio.playbackRate=.85;audio.preservesPitch=true;}
 announce('Loading '+(audio===narr?activeVoice.dataset.name:activeSound.dataset.name)+'…');
 audio.play().catch(error=>{
  if(error.name==='AbortError')return;
  if(token!==(audio===narr?voiceRequest:soundRequest))return;
  announce('This preview could not play. Please try again.',true);update();
 });
}
voiceButtons.forEach(button=>button.addEventListener('click',()=>{
 if(activeVoice===button && playing(narr)){narr.pause();return;}
 if(activeVoice!==button) {narr.pause();activeVoice=button;narr.src=button.dataset.audio;narr.load();document.getElementById('listen-fill').style.width='0%';}
 begin(narr);
}));
soundButtons.forEach(button=>button.addEventListener('click',()=>{
 if(activeSound===button && playing(room)){room.pause();return;}
 if(activeSound!==button) {room.pause();activeSound=button;room.src=button.dataset.audio;room.load();document.getElementById('ambient-fill').style.width='0%';}
 begin(room);
}));
toggle.addEventListener('click',()=>{if(!activeSound)return;if(playing(room))room.pause();else begin(room);});
volume.addEventListener('input',()=>{
 document.getElementById('room-volume-value').textContent=volume.value+'%';
 volume.setAttribute('aria-valuetext',volume.value+' percent');mixLevel();
});
for(const audio of [narr,room]){
 audio.addEventListener('play',update);
 audio.addEventListener('playing',()=>{if(audio===room)openingFade();update();describe();});
 audio.addEventListener('waiting',()=>announce('Loading preview…'));
 audio.addEventListener('pause',()=>{
  update();
  // A failed load can queue pause after error. Keep its recovery message visible.
  if(!audio.error && status.dataset.error!=='true')describe();
 });
 audio.addEventListener('ended',()=>{
  update();
  if(!playing(narr)&&!playing(room)) announce('Preview finished. Choose another voice or sound.');
  else describe();
 });
 audio.addEventListener('error',()=>{update();announce('This preview could not load. Please try another.',true);});
}
narr.addEventListener('loadedmetadata',()=>{narr.playbackRate=.85;});
narr.addEventListener('timeupdate',()=>{
 if(Number.isFinite(narr.duration)){
  document.getElementById('listen-fill').style.width=100*narr.currentTime/narr.duration+'%';
  document.getElementById('listen-time').textContent=(activeVoice?activeVoice.dataset.name+' · ':'')+format((narr.duration-narr.currentTime)/.85)+' remaining';
 }
});
room.addEventListener('timeupdate',()=>{if(Number.isFinite(room.duration))document.getElementById('ambient-fill').style.width=100*room.currentTime/room.duration+'%';});
function stopAll(){voiceRequest++;soundRequest++;narr.pause();room.pause();narr.currentTime=0;room.currentTime=0;update();announce('All previews stopped.');}
stop.addEventListener('click',stopAll);
document.addEventListener('visibilitychange',()=>{if(document.hidden)stopAll();});
update();
})();