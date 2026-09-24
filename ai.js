(()=>{
"use strict";
const q=s=>document.querySelector(s);
const qa=s=>[...document.querySelectorAll(s)];
const DEFAULTS=[
  "https://my-life-dashboard-api.onrender.com",
  "https://my-life-dashboard.onrender.com"
];
const PROFILE_KEY="my-life-ai-profile-v1";
const API_KEY="my-life-dashboard-api-url";
const CHAT_KEY="my-life-ai-chat-v2";
const DASHBOARD_KEY="my-life-dashboard-v1";

const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]));
const profile=()=>{try{return JSON.parse(localStorage.getItem(PROFILE_KEY)||"{}")}catch{return{}}};
const saveProfile=p=>localStorage.setItem(PROFILE_KEY,JSON.stringify(p));
const storedApi=()=>localStorage.getItem(API_KEY)||"";
const setApi=u=>localStorage.setItem(API_KEY,String(u||"").replace(/\/$/,""));

function candidates(){
  const out=[];
  const add=u=>{u=String(u||"").trim().replace(/\/$/,"");if(/^https?:\/\//i.test(u)&&!out.includes(u))out.push(u)};
  add(storedApi());
  DEFAULTS.forEach(add);
  return out;
}
async function request(base,path,options={},timeout=12000){
  const c=new AbortController();
  const timer=setTimeout(()=>c.abort(),timeout);
  try{
    return await fetch(base+path,{...options,signal:c.signal});
  }finally{clearTimeout(timer)}
}
async function probe(base){
  const r=await request(base,"/health",{cache:"no-store"},7000);
  if(!r.ok)throw Error("HTTP "+r.status);
  return await r.json();
}
async function discover(){
  const saved=storedApi();
  if(saved){
    try{const h=await probe(saved);return{base:saved,health:h}}catch{}
  }
  for(const base of DEFAULTS){
    try{
      const h=await probe(base);
      setApi(base);
      return{base,health:h};
    }catch{}
  }
  return{base:saved||DEFAULTS[0],health:null};
}
async function api(path,body){
  const found=await discover();
  let r;
  try{
    r=await request(found.base,path,{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify(body)
    },30000);
  }catch(e){
    throw Error("Backend niet bereikbaar op "+found.base+". Open AI Settings en test de verbinding.");
  }
  const d=await r.json().catch(()=>({}));
  if(!r.ok)throw Error(d.message||d.error||("AI-server HTTP "+r.status));
  return d;
}
function show(view){
  qa(".view").forEach(v=>v.classList.remove("active"));
  const v=q("#view-"+view);
  if(v)v.classList.add("active");
  qa(".nav-item").forEach(b=>b.classList.toggle("active",b.dataset.view===view));
  const t=q("#viewTitle");if(t)t.textContent=view==="ai"?"AI":view==="ai-settings"?"AI Settings":view;
  history.replaceState(null,"","#"+view);
}
function addNav(view,icon,label){
  const nav=q(".sidebar nav");if(!nav)return;
  let b=nav.querySelector('[data-view="'+view+'"]');
  if(!b){
    b=document.createElement("button");
    b.className="nav-item";
    b.dataset.view=view;
    b.innerHTML="<span>"+icon+"</span>"+label;
    nav.appendChild(b);
  }
  b.onclick=()=>show(view);
}
function chatHistory(){try{return JSON.parse(localStorage.getItem(CHAT_KEY)||"[]")}catch{return[]}}
function saveChatHistory(h){localStorage.setItem(CHAT_KEY,JSON.stringify(h.slice(-14)))}
function dashboardState(){try{return JSON.parse(localStorage.getItem(DASHBOARD_KEY)||"{}")}catch{return{}}}
function ensureSettings(){
  if(q("#view-ai-settings"))return;
  const v=document.createElement("section");
  v.className="view";
  v.id="view-ai-settings";
  v.innerHTML='<div class="page-head"><div><p class="eyebrow">MY LIFE AI</p><h1>AI Settings</h1><p>AI-model, persoonlijke voorkeuren en verbinding.</p></div><button class="ghost-btn" id="aiBack">← Terug naar AI</button></div>'+
  '<div class="ai-settings-grid">'+
  '<article class="panel"><div class="panel-head"><div><span class="panel-kicker">VERBINDING</span><h2>AI Backend</h2></div></div>'+
  '<div class="form-field"><label>API URL</label><input id="aiApiUrl" class="search" placeholder="https://jouw-api.onrender.com"></div>'+
  '<div style="display:flex;gap:10px;margin-top:12px;flex-wrap:wrap"><button class="primary-btn" id="testAIConnection">Test verbinding</button><button class="ghost-btn" id="resetAIConnection">Automatisch vinden</button></div>'+
  '<div id="aiConnectionResult" class="ai-saved" style="margin-top:12px"></div></article>'+
  '<article class="panel"><div class="panel-head"><div><span class="panel-kicker">MODEL</span><h2>Gemini</h2></div></div>'+
  '<div class="form-field"><label>Model</label><select id="aiModelSelect" class="ai-model-select"><option value="gemini-3.8-flash">Gemini 3.8 Flash</option><option value="gemini-3.7-flash">Gemini 3.7 Flash</option><option value="gemini-3.5-flash">Gemini 3.5 Flash</option><option value="gemini-3.5-flash-lite">Gemini 3.5 Flash-Lite</option><option value="gemini-3.1-flash-lite">Gemini 3.1 Flash-Lite</option></select></div>'+
  '<div class="form-field" style="margin-top:12px"><label>Naam</label><input id="aiName" class="search" placeholder="Bijv. Christian"></div>'+
  '<div class="form-field" style="margin-top:12px"><label>Extra instructies</label><textarea id="aiCustom" class="search" rows="5" placeholder="Bijv. antwoord in het Nederlands en wees duidelijk."></textarea></div>'+
  '<button class="primary-btn" id="saveSimpleAI">✓ Opslaan</button><div id="aiSimpleSaved" class="ai-saved"></div></article>'+
  '</div>';
  q(".content")?.appendChild(v);
  q("#aiBack").onclick=()=>show("ai");
  q("#testAIConnection").onclick=async()=>{
    const box=q("#aiConnectionResult"),url=(q("#aiApiUrl").value||"").trim().replace(/\/$/,"");
    if(!url){box.textContent="Vul eerst een API URL in.";return}
    box.textContent="Verbinden…";
    try{const h=await probe(url);setApi(url);box.textContent="✓ Verbinding werkt · "+(h.ai?"AI-key aanwezig":"Backend werkt, maar GEMINI_API_KEY ontbreekt in Render.");updateStatus()}catch(e){box.textContent="✕ Verbinding mislukt · "+e.message}
  };
  q("#resetAIConnection").onclick=async()=>{
    localStorage.removeItem(API_KEY);
    q("#aiApiUrl").value=DEFAULTS[0];
    q("#aiConnectionResult").textContent="Automatische detectie wordt gebruikt.";
    updateStatus();
  };
  q("#saveSimpleAI").onclick=()=>{
    const p=profile();
    p.model=q("#aiModelSelect").value;
    p.name=q("#aiName").value.trim();
    p.custom=q("#aiCustom").value.trim();
    p.tone=q("#aiTone").value;
    p.focus={tasks:q("#focusTasks").checked,school:q("#focusSchool").checked,planning:q("#focusPlanning").checked,goals:q("#focusGoals").checked,flights:q("#focusFlights").checked,general:q("#focusGeneral").checked};
    saveProfile(p);
    q("#aiSimpleSaved").textContent="✓ AI-instellingen opgeslagen.";
  };
  loadSettings();
}
function loadSettings(){
  ensureSettings();
  const p=profile();
  if(q("#aiApiUrl"))q("#aiApiUrl").value=storedApi()||DEFAULTS[0];
  if(q("#aiModelSelect"))q("#aiModelSelect").value=p.model||"gemini-3.8-flash";
  if(q("#aiName"))q("#aiName").value=p.name||"";
  if(q("#aiCustom"))q("#aiCustom").value=p.custom||"";
  if(q("#aiTone"))q("#aiTone").value=p.tone||"friendly";
  ["Tasks","School","Planning","Goals","Flights","General"].forEach(k=>{const el=q("#focus"+k);if(el)el.checked=p.focus?.[k.toLowerCase()]!==false});
}
async function updateStatus(){
  const box=q("#aiStatus");if(!box)return;
  box.innerHTML='<span class="ai-dot"></span> AI controleren…';
  const found=await discover();
  if(!found.health){
    box.innerHTML='<span class="ai-dot bad"></span> AI backend offline';
    return;
  }
  if(found.health.ai){
    box.innerHTML='<span class="ai-dot ok"></span> AI online · '+esc(found.health.aiModel||"Gemini");
  }else{
    box.innerHTML='<span class="ai-dot bad"></span> Backend online · Gemini-key ontbreekt';
  }
}
function context(){
  const s=dashboardState();
  return{
    today:new Date().toISOString().slice(0,10),
    tasks:(s.tasks||[]).slice(0,80),
    calendarEvents:(s.calendarEvents||[]).slice(0,80),
    flights:(s.flights||[]).slice(-30),
    plannedFlight:s.plannedFlight||null,
    goals:(()=>{try{return JSON.parse(localStorage.getItem("my-life-goals-v1")||"[]")}catch{return[]}})(),
    aiProfile:profile(),
    recentConversation:chatHistory().slice(-10)
  };
}
function addMessage(role,text){
  const box=q("#aiMessages");if(!box)return null;
  const d=document.createElement("div");d.className="ai-bubble "+role;d.textContent=text;box.appendChild(d);box.scrollTop=box.scrollHeight;return d;
}
async function send(){
  const input=q("#aiInput"),text=input?.value.trim()||"",file=q("#aiImage")?.files?.[0];
  if(!text&&!file)return;
  addMessage("user",(text||"Analyseer deze afbeelding.")+(file?"\n📷 "+file.name:""));
  if(input)input.value="";
  const wait=addMessage("assistant","Even kijken…");
  try{
    let image=null;
    if(file){
      image=await new Promise((resolve,reject)=>{
        const r=new FileReader();
        r.onload=()=>resolve({mimeType:file.type,data:String(r.result).split(",")[1]});
        r.onerror=reject;r.readAsDataURL(file);
      });
    }
    const p=profile();
    const d=await api("/api/ai/chat",{message:text||"Analyseer deze afbeelding en help me ermee.",context:context(),model:p.model||"gemini-3.8-flash",image});
    const answer=d.text||"Geen antwoord ontvangen.";
    wait.textContent=answer;
    const updated=chatHistory();updated.push({role:"assistant",text:answer});saveChatHistory(updated);
    updateStatus();
  }catch(e){
    wait.textContent="❌ "+e.message;
    updateStatus();
  }
}
function init(){
  addNav("ai","✦","AI");
  addNav("ai-settings","⚙","AI Settings");
  ensureSettings();
  const form=q("#aiForm");
  if(form&&!form.dataset.aiBound){
    form.dataset.aiBound="1";
    form.addEventListener("submit",e=>{e.preventDefault();send()});
  }
  const open=q("#openAISettings");
  if(open&&!open.dataset.aiBound){open.dataset.aiBound="1";open.onclick=()=>{loadSettings();show("ai-settings")}}
  const clear=q("#clearAI");
  if(clear&&!clear.dataset.aiBound){clear.dataset.aiBound="1";clear.onclick=()=>{localStorage.removeItem(CHAT_KEY);q("#aiMessages").innerHTML='<div class="ai-bubble assistant">Chat gewist. Waar wil je mee aan de slag?</div>'}}
  if(location.hash==="#ai-settings")show("ai-settings");
  else if(location.hash==="#ai")show("ai");
  updateStatus();
}
window.addEventListener("load",init);
})();