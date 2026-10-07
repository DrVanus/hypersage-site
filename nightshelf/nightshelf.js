(() => {
'use strict';
const gallery = document.querySelector('.screen-gallery');
const previous = document.querySelector('.gallery-prev');
const next = document.querySelector('.gallery-next');
if (gallery && previous && next) {
 const update = () => { previous.disabled = gallery.scrollLeft < 4; next.disabled = gallery.scrollLeft + gallery.clientWidth >= gallery.scrollWidth - 4; };
 const move = direction => gallery.scrollBy({left: direction * (gallery.querySelector('.screen-card').offsetWidth + parseFloat(getComputedStyle(gallery).gap)), behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'});
 previous.addEventListener('click', () => move(-1));
 next.addEventListener('click', () => move(1));
 gallery.addEventListener('scroll', update, {passive:true});
 window.addEventListener('resize', update); update();
}
const narr = document.getElementById('listen-audio');
const room = document.getElementById('ambient-audio');
const play = document.getElementById('listen-play');
const status = document.getElementById('audio-status');
const roomButtons = Array.from(document.querySelectorAll('.amb-btn'));
let activeRoom = null;
const format = seconds => { const value = Math.max(0, Math.ceil(seconds)); return Math.floor(value / 60) + ':' + String(value % 60).padStart(2, '0'); };
const error = () => { status.textContent = 'The sample could not load. Please try again.'; };
const clear = () => { roomButtons.forEach(button => { button.classList.remove('playing'); button.setAttribute('aria-pressed', 'false'); button.setAttribute('aria-label', 'Play ' + button.innerText.trim()); }); };
const playAudio = audio => { status.textContent = ''; audio.play().catch(error); };
roomButtons.forEach(button => {
 button.setAttribute('aria-pressed', 'false');
 button.addEventListener('click', () => {
  if (activeRoom === button && !room.paused) { room.pause(); return; }
  narr.pause();
  const src = button.dataset.audio;
  if (room.getAttribute('src') !== src) { room.src = src; room.load(); }
  activeRoom = button; playAudio(room);
 });
});
play.setAttribute('aria-pressed', 'false');
play.addEventListener('click', () => { if (narr.paused) {room.pause(); playAudio(narr);} else narr.pause(); });
narr.addEventListener('play', () => {room.pause(); play.classList.add('playing'); play.setAttribute('aria-label','Pause the narration sample'); play.setAttribute('aria-pressed','true');});
narr.addEventListener('pause', () => {play.classList.remove('playing'); play.setAttribute('aria-label','Play the narration sample'); play.setAttribute('aria-pressed','false');});
narr.addEventListener('timeupdate', () => {
 if (Number.isFinite(narr.duration)) { document.getElementById('listen-fill').style.width = 100*narr.currentTime/narr.duration+'%'; document.getElementById('listen-time').textContent=format(narr.duration-narr.currentTime); }
});
narr.addEventListener('ended', () => {document.getElementById('listen-fill').style.width='0%'; document.getElementById('listen-time').textContent=format(narr.duration || 10);});
room.addEventListener('play', () => { narr.pause(); clear(); if(activeRoom){activeRoom.classList.add('playing');activeRoom.setAttribute('aria-pressed','true');activeRoom.setAttribute('aria-label','Pause '+activeRoom.innerText.trim());} });
room.addEventListener('pause',clear);
room.addEventListener('ended',()=>{clear();document.getElementById('ambient-fill').style.width='0%';});
room.addEventListener('timeupdate',()=>{if(Number.isFinite(room.duration))document.getElementById('ambient-fill').style.width=100*room.currentTime/room.duration+'%';});
[narr,room].forEach(audio=>audio.addEventListener('error',error));
document.addEventListener('visibilitychange',()=>{if(document.hidden){narr.pause();room.pause();}});
})();