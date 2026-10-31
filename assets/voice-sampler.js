/* BEGIN HYPERSAGE VOICE SAMPLER CONTROLLER — one audio element; no automatic playback. */
(() => {
"use strict";
const voices = JSON.parse(document.querySelector("#voice-data").textContent);
const section = document.querySelector("#voices");
const byId = new Map(voices.map(v => [v.id,v]));
const audio = section.querySelector("#voice-audio");
const play = section.querySelector("#play-toggle");
const stateEl = section.querySelector("#play-state");
const progress = section.querySelector("#progress");
let voice = voices[0], state = "ready", generation = 0, playRequest = 0, wantsPlay = false;
const lastByApp = { nightshelf: "mira", quietoak: "willow" };
const symbols = {
 play:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.8v14.4c0 .8.9 1.3 1.6.8l11-7.2c.6-.4.6-1.2 0-1.6l-11-7.2c-.7-.5-1.6 0-1.6.8Z"/></svg>',
 pause:'<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>',
 loading:'<svg viewBox="0 0 24 24" aria-hidden="true"><circle opacity=".25" cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 8 8"/></svg>'
};
const expectedURL = () => new URL(voice.src, document.baseURI).href;
const currentSource = () => audio.currentSrc === expectedURL() || (!audio.currentSrc && audio.src === expectedURL());
const fmt = n => Number.isFinite(n) ? Math.floor(n / 60) + ":" + String(Math.floor(n % 60)).padStart(2,"0") : "0:00";
function updateTime() {
 const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
 progress.value = duration ? Math.min(1, audio.currentTime / duration) : 0;
 section.querySelector("#time").textContent = duration ? fmt(audio.currentTime || 0) + " / " + fmt(duration) : "Short preview";
}
function setState(next, detail) {
 state = next;
 play.dataset.state = next;
 const active = next === "playing" || next === "loading";
 play.innerHTML = symbols[next === "loading" ? "loading" : active ? "pause" : "play"];
 play.setAttribute("aria-label", (active ? "Pause " : "Play ") + voice.name + " sample");
 section.querySelector("#play-action").textContent = next === "loading" ? "Loading " + voice.name + "…" : next === "playing" ? "Listening to " + voice.name : next === "ended" ? "Listen again" : next === "paused" ? "Continue listening" : "Listen to " + voice.name;
 const labels = { ready:"Ready when you are", loading:"Loading audio…", playing:"Playing", paused:"Paused", ended:"Sample finished", error:"Audio unavailable. Try again." };
 stateEl.textContent = detail || labels[next];
}
function stop(reason) {
 const wasActive = state === "playing" || state === "loading";
 wantsPlay = false; playRequest++;
 audio.pause();
 if (wasActive) setState("paused", reason || "Paused");
}
function select(id) {
 const selected = byId.get(id); if (!selected) return;
 generation++; wantsPlay = false; playRequest++;
 audio.pause(); audio.removeAttribute("src"); audio.load();
 voice = selected; lastByApp[voice.group] = voice.id;
 for (const node of section.querySelectorAll("[data-selected-app]")) node.dataset.app = voice.group;
 for (const node of section.querySelectorAll("[data-voice]")) {
  node.setAttribute("aria-pressed", String(node.dataset.voice === voice.id));
  if (node.classList.contains("voice-option")) node.hidden = byId.get(node.dataset.voice).group !== voice.group;
 }
 for (const node of section.querySelectorAll("[data-group]")) node.setAttribute("aria-pressed",String(node.dataset.group === voice.group));
 for (const node of section.querySelectorAll("[data-current-name]")) node.textContent = voice.name;
 for (const node of section.querySelectorAll("[data-current-role]")) node.textContent = voice.role;
 for (const node of section.querySelectorAll("[data-current-art]")) { node.src = voice.portrait; node.width = voice.width; node.height = voice.height; node.alt = voice.name + ", " + voice.app + " " + (voice.group === "nightshelf" ? "narrator" : "companion") + " illustration"; }
 for (const node of section.querySelectorAll("[data-current-status]")) {node.textContent = voice.status; node.classList.toggle("coming",voice.group === "quietoak");}
 section.querySelector("#transcript").textContent = "“" + voice.transcript + "”";
 const appLink = section.querySelector("#app-link"); appLink.href = voice.href; appLink.textContent = "Explore " + voice.app + " →";
 const label = section.querySelector("#stage-label"); if (label) label.textContent = voice.app + " / " + (voice.group === "nightshelf" ? "Narrators" : "Companions");
 const foot = section.querySelector("#stage-foot"); if (foot) foot.textContent = voice.group === "nightshelf" ? "Stories for winding down." : "A little space to be yourself.";
 progress.value = 0; section.querySelector("#time").textContent = "Short preview";
 setState("ready");
}
async function toggle() {
 if (state === "playing" || state === "loading") { stop(); return; }
 const myGeneration = generation, myRequest = ++playRequest;
 wantsPlay = true;
 if (audio.src !== expectedURL() || state === "error") { audio.src = voice.src; audio.load(); }
 if (state === "ended") audio.currentTime = 0;
 audio.defaultPlaybackRate = voice.rate;
 audio.playbackRate = voice.rate;
 audio.volume = Math.max(0, Math.min(1, voice.volume));
 setState("loading");
 try {
  await audio.play();
  if (myGeneration !== generation || myRequest !== playRequest) return;
  if (!wantsPlay) audio.pause();
 } catch (error) {
  if (myGeneration !== generation || myRequest !== playRequest) return;
  wantsPlay = false;
  audio.pause();
  setState("error", error.name === "NotAllowedError" ? "Press play to allow audio." : "Audio unavailable. Try again.");
 }
}
for (const node of section.querySelectorAll("[data-voice]")) node.addEventListener("click",() => select(node.dataset.voice));
for (const node of section.querySelectorAll("[data-group]")) node.addEventListener("click",() => select(lastByApp[node.dataset.group]));
play.addEventListener("click",toggle);
audio.addEventListener("playing",() => { if (currentSource() && wantsPlay && !audio.paused) setState("playing"); });
for (const event of ["waiting","stalled"]) audio.addEventListener(event,() => { if (currentSource() && wantsPlay) setState("loading"); });
audio.addEventListener("pause",() => { if (currentSource() && audio.paused && !audio.ended && (state === "playing" || state === "loading")) { wantsPlay = false; setState("paused"); } });
audio.addEventListener("ended",() => { if (currentSource() && audio.ended) {wantsPlay = false; setState("ended"); updateTime();} });
audio.addEventListener("error",() => { if (currentSource() && audio.error) {wantsPlay = false; audio.pause(); setState("error");} });
for (const event of ["timeupdate","durationchange","loadedmetadata"]) audio.addEventListener(event,() => { if (currentSource()) updateTime(); });
document.addEventListener("visibilitychange",() => { if (document.hidden) stop("Paused while you were away"); });
window.addEventListener("pagehide",() => stop("Paused"));
select(voices[0].id);
section.classList.add("voice-ready");
})();
/* END HYPERSAGE VOICE SAMPLER CONTROLLER */
