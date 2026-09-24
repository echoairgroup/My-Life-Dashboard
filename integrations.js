(() => {
  const KEY = "my-life-dashboard-api-url";
  const apiBase = () => (localStorage.getItem(KEY) || window.MY_LIFE_API_URL || "").replace(/\/$/, "");
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;" }[c]));
  const state = { magister: [], newsky: [], simbrief: null };

  async function get(path) {
    const base = apiBase();
    if (!base) throw new Error("API URL ontbreekt");
    const r = await fetch(base + path);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || "API fout");
    return data;
  }

  function sameDay(a,b) {
    const x=new Date(a), y=new Date(b);
    return x.getFullYear()===y.getFullYear() && x.getMonth()===y.getMonth() && x.getDate()===y.getDate();
  }
  const time = x => x ? new Intl.DateTimeFormat("nl-NL",{hour:"2-digit",minute:"2-digit"}).format(new Date(x)) : "—";

  function add() {
    if (document.querySelector("#view-integrations")) return;
    const nav=document.querySelector(".sidebar nav");
    if(!nav) return;
    const b=document.createElement("button");
    b.className="nav-item"; b.dataset.view="integrations"; b.innerHTML="<span>↻</span>Integraties";
    nav.appendChild(b); b.onclick=show;

    const v=document.createElement("section");
    v.className="view"; v.id="view-integrations";
    v.innerHTML=`
      <div class="page-head"><div><p class="eyebrow">KOPPELINGEN</p><h1>Integraties</h1><p>Magister, NewSky en SimBrief in één overzicht.</p></div><button class="primary-btn" id="integrationSync">↻ Alles synchroniseren</button></div>
      <div class="dashboard-grid">
        <article class="panel large"><div class="panel-head"><div><span class="panel-kicker">MAGISTER</span><h2>Vandaag</h2></div><span class="badge" id="magisterBadge">—</span></div><div id="magisterToday" class="task-list"></div></article>
        <article class="panel"><div class="panel-head"><div><span class="panel-kicker">SIMBRIEF</span><h2>Volgende vlucht</h2></div></div><div id="simbriefCard"></div></article>
        <article class="panel large"><div class="panel-head"><div><span class="panel-kicker">NEWSKY</span><h2>Automatisch gelogde vluchten</h2></div><span class="badge" id="newskyBadge">0</span></div><div id="newskyList" class="task-list"></div></article>
        <article class="panel"><div class="panel-head"><div><span class="panel-kicker">SYSTEEM</span><h2>Verbinding</h2></div></div><div id="integrationStatus"></div><label style="display:block;margin-top:16px;font-size:10px;color:var(--muted)">API URL<input id="apiUrl" style="width:100%;margin-top:7px;background:var(--surface2);color:var(--text);border:1px solid var(--line);border-radius:8px;padding:10px" placeholder="https://jouw-api.onrender.com"></label><button class="ghost-btn" id="saveApi" style="margin-top:8px">Opslaan</button><p class="muted">Je Magister-link hoort alleen als geheime environment variable op de backend te staan.</p></article>
      </div>`;
    document.querySelector(".content").appendChild(v);
    document.querySelector("#integrationSync").onclick=sync;
    document.querySelector("#saveApi").onclick=()=>{localStorage.setItem(KEY,document.querySelector("#apiUrl").value.trim());toast("API URL opgeslagen");sync();};
  }

  function show(){ add(); document.querySelectorAll(".view").forEach(x=>x.classList.remove("active")); document.querySelector("#view-integrations").classList.add("active"); document.querySelectorAll(".nav-item").forEach(x=>x.classList.toggle("active",x.dataset.view==="integrations")); document.querySelector("#viewTitle").textContent="Integraties"; history.replaceState(null,"","#integrations"); render(); }
  function render(){
    const today=state.magister.filter(x=>sameDay(x.start,new Date())).sort((a,b)=>new Date(a.start)-new Date(b.start));
    const m=document.querySelector("#magisterToday");
    if(m)m.innerHTML=today.length?today.map(x=>`<div class="task"><div class="task-main"><div class="task-title">${esc(x.title)}</div><div class="task-meta">${time(x.start)}–${time(x.end)} · ${esc(x.location||"Geen lokaal")}</div></div></div>`).join(""):`<div class="empty-state"><strong>Geen lessen vandaag</strong><span>Of de Magister-koppeling is nog niet ingesteld.</span></div>`;
    const mb=document.querySelector("#magisterBadge"); if(mb)mb.textContent=today.length+" lessen";
    const f=document.querySelector("#simbriefCard");
    if(f){const x=state.simbrief; f.innerHTML=x?`<div class="flight-preview"><strong style="font-size:22px">${esc(x.dep)} → ${esc(x.arr)}</strong><div class="task-meta">${esc(x.flightNumber||"SimBrief")} · ${esc(x.aircraft||"Aircraft")} · ${x.distance?Number(x.distance).toLocaleString("nl-NL")+" NM":"—"}</div></div>`:`<div class="empty-state"><strong>Geen SimBrief OFP</strong><span>Stel je SimBrief-account in op de backend.</span></div>`;}
    const n=document.querySelector("#newskyList");
    if(n){const xs=state.newsky.slice(-10).reverse();n.innerHTML=xs.length?xs.map(x=>`<div class="task"><div class="task-main"><div class="task-title">${esc(x.flightNumber||"Flight")} · ${esc(x.dep)} → ${esc(x.arr)}</div><div class="task-meta">${esc(x.aircraft||"Aircraft")} · ${x.distance?x.distance+" NM":"—"} ${x.rating?"· ★ "+x.rating:""}</div></div></div>`).join(""):`<div class="empty-state"><strong>Nog geen vluchten</strong><span>NewSky wordt automatisch ingelezen zodra de API actief is.</span></div>`;}
    const nb=document.querySelector("#newskyBadge");if(nb)nb.textContent=state.newsky.length+" vluchten";
    const input=document.querySelector("#apiUrl");if(input&&!input.value)input.value=apiBase();
    status();
  }
  async function status(){const box=document.querySelector("#integrationStatus");if(!box)return;if(!apiBase()){box.innerHTML='<span class="badge">API niet ingesteld</span>';return}try{const x=await get("/api/integrations/status");box.innerHTML=`<div class="integration-status"><span class="badge">${x.magister?"✓ Magister":"○ Magister"}</span><span class="badge">${x.newsky?"✓ NewSky":"○ NewSky"}</span><span class="badge">${x.simbrief?"✓ SimBrief":"○ SimBrief"}</span></div>`}catch{box.innerHTML='<span class="badge">API niet bereikbaar</span>';}}
  async function sync(){if(!apiBase()){show();toast("Vul eerst je API URL in");return}try{const x=await get("/api/dashboard/sync");state.magister=x.magister?.events||[];
state.newsky=x.newsky?.flights||[];
state.simbrief=x.simbrief?.flight||null;
state.calendarEvents=state.magister.map(e=>({id:"magister-"+e.id,title:e.title,start:e.start,end:e.end,location:e.location,source:"magister"}));
const existing=new Map((state.flights||[]).map(f=>[String(f.id||f.newskyId||""),f]));
for(const f of state.newsky){const id=String(f.id||"");if(!id||existing.has(id))continue;existing.set(id,{id,newskyId:id,date:f.date?new Date(f.date).toISOString().slice(0,10):todayISO(),aircraft:f.aircraft||"Aircraft",dep:f.dep,arr:f.arr,distance:Number(f.distance||0),duration:Number(f.duration||0),rating:Number(f.rating||0),source:"newsky"});}
state.flights=[...existing.values()];
state.plannedFlight=state.simbrief||null;
save();
localStorage.setItem("my-life-dashboard-integrations-cache",JSON.stringify({magister:state.magister,newsky:state.newsky,simbrief:state.simbrief}));
render();
toast("Alles gesynchroniseerd")}catch(e){console.error(e);toast("Synchronisatie mislukt")}}
  window.MyLifeIntegrations={sync,show};
  window.addEventListener("load",()=>{add();try{Object.assign(state,JSON.parse(localStorage.getItem("my-life-dashboard-integrations-cache")||"{}"))}catch{};if(location.hash==="#integrations")show();if(apiBase())setTimeout(sync,1000);setInterval(()=>{if(apiBase()&&document.visibilityState==="visible")sync()},300000);});
})();