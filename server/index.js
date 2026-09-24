import express from "express";
import cors from "cors";
import ICAL from "ical.js";

const app=express();
const PORT=process.env.PORT||10000;
app.use(cors({origin:true}));
const MAGISTER=process.env.MAGISTER_FEED_URL||"";
const NEWSKY_ID=process.env.NEWSKY_AIRLINE_ID||"6671c567ed19d758f72965d4";
const SIMBRIEF=process.env.SIMBRIEF_USERNAME||"";
let cache={m:{at:0,data:[]},n:{at:0,data:[]},s:{at:0,data:null}};
const fresh=x=>x.at&&Date.now()-x.at<120000;
const pick=(o,...ks)=>{for(const k of ks){const v=k.split(".").reduce((a,b)=>a?.[b],o);if(v!==undefined&&v!==null&&v!=="")return v}return""};
const arraysDeep=(value,seen=new Set())=>{if(!value||typeof value!=="object"||seen.has(value))return[];seen.add(value);const out=[];if(Array.isArray(value))out.push(value);for(const v of Object.values(value)){if(v&&typeof v==="object")out.push(...arraysDeep(v,seen))}return out};
const asNumber=v=>{const n=Number(v);return Number.isFinite(n)?n:0};
const durationMinutes=v=>{if(v===null||v===undefined||v==="")return 0;if(typeof v==="number")return v;const str=String(v).trim();if(/^\d{3,4}$/.test(str)){const n=Number(str),mins=n%100,hours=Math.floor(n/100);return hours*60+mins}if(/^\d+:\d{2}$/.test(str)){const [h,m]=str.split(":").map(Number);return h*60+m}return asNumber(str)};
const clean=x=>String(x??"").replace(/\\n/g," ").replace(/\\,/g,",").trim();

async function magister(){
 if(!MAGISTER)return{configured:false,events:[]};
 if(fresh(cache.m))return{configured:true,events:cache.m.data};
 const url=MAGISTER.replace(/^webcal:/i,"https:");
 const r=await fetch(url);if(!r.ok)throw Error("Magister HTTP "+r.status);
 const c=new ICAL.Component(ICAL.parse(await r.text()));
 const events=c.getAllSubcomponents("vevent").map(v=>{const e=new ICAL.Event(v),s=e.startDate?.toJSDate?.(),end=e.endDate?.toJSDate?.();return{id:v.getFirstPropertyValue("uid")||crypto.randomUUID(),title:clean(e.summary),start:s?.toISOString(),end:end?.toISOString(),location:clean(e.location),description:clean(e.description),source:"magister"}}).filter(x=>x.start);
 cache.m={at:Date.now(),data:events};return{configured:true,events};
}
async function newsky(){
 if(fresh(cache.n))return{configured:true,flights:cache.n.data,diagnostics:cache.n.diagnostics||null};
 const now=new Date(),from=new Date(now);from.setDate(now.getDate()-90);
 const iso=d=>d.toISOString().slice(0,10);
 const q=encodeURIComponent(NEWSKY_ID);
 const urls=[
  `https://newsky.app/api/airline-api/flights/bydate?airlineId=${q}&from=${iso(from)}&to=${iso(now)}&page=1&limit=100`,
  `https://newsky.app/api/airline-api/flights/bydate?airlineId=${q}&startDate=${iso(from)}&endDate=${iso(now)}&page=1&limit=100`,
  `https://newsky.app/api/airline-api/flights/bydate?airline=${q}&from=${iso(from)}&to=${iso(now)}&page=1&limit=100`,
  `https://newsky.app/api/airline-api/flights/bydate?airlineId=${q}`
 ];
 let last;
 const diagnostics=[];
 for(const u of urls)try{
  const r=await fetch(u,{headers:{accept:"application/json","user-agent":"My-Life-Dashboard/1.0"}});
  const text=await r.text();
  let p;try{p=JSON.parse(text)}catch{p=null}
  const diag={url:u.replace(q,"<airline-id>"),status:r.status,contentType:r.headers.get("content-type")||"",keys:p&&typeof p==="object"&&!Array.isArray(p)?Object.keys(p).slice(0,30):[],bodyPreview:p?undefined:text.slice(0,300)};
  diagnostics.push(diag);
  if(!r.ok){last=Error("NewSky HTTP "+r.status);continue}
  const candidates=arraysDeep(p).filter(a=>a.some(x=>x&&typeof x==="object"&&!Array.isArray(x)));
  const a=(Array.isArray(p)?p:null)||p?.flights||p?.data||p?.results||p?.items||p?.rows||candidates.sort((x,y)=>y.length-x.length)[0]||[];
  const flights=a.filter(f=>f&&typeof f==="object").map(f=>({
   id:String(pick(f,"_id","id","flightId","uuid")||crypto.randomUUID()),
   flightNumber:String(pick(f,"flightNumber","callsign","flight_number","flight.number","number")||""),
   dep:String(pick(f,"dep.icao","dep","departure.icao","departure","origin.icao","origin","originIcao","departureIcao")||""),
   arr:String(pick(f,"arr.icao","arr","arrival.icao","arrival","destination.icao","destination","destinationIcao","arrivalIcao")||""),
   aircraft:String(pick(f,"aircraft.icao","aircraft","airframe.icao","airframe","aircraftType","aircraftCode")||""),
   duration:durationMinutes(pick(f,"duration","flightTime","durationMinutes","flight_time","time")||0),
   distance:asNumber(pick(f,"distance","distanceNm","distanceNM","flightDistance","nm")||0),
   rating:asNumber(pick(f,"rating","score","stars","flightRating")||0),
   date:pick(f,"date","depTime","departureTime","createdAt","completedAt","finishedAt","dateTime")||null,
   source:"newsky"
  })).filter(f=>f.dep&&f.arr);
  if(flights.length){
   cache.n={at:Date.now(),data:flights,diagnostics};
   return{configured:true,flights,diagnostics};
  }
  last=Error("NewSky gaf een lege vluchtlijst terug");
 }catch(e){last=e;diagnostics.push({url:u.replace(q,"<airline-id>"),error:e.message})}
 throw Object.assign(last||Error("NewSky niet bereikbaar"),{diagnostics});
}
async function simbrief(){
 if(!SIMBRIEF)return{configured:false,flight:null};
 if(fresh(cache.s))return{configured:true,flight:cache.s.data};
 const u="https://www.simbrief.com/api/xml.fetcher.php?username="+encodeURIComponent(SIMBRIEF)+"&json=1";
 const r=await fetch(u);if(!r.ok)throw Error("SimBrief HTTP "+r.status);
 const d=await r.json(),g=d.general||{},o=d.origin||{},a=d.destination||{},ac=d.aircraft||{},t=d.times||{},at=d.atc||{};
 const f={id:String(pick(g,"static_id","flight_number")||Date.now()),flightNumber:String(pick(g,"flight_number")||""),dep:String(pick(o,"icao_code","icao")||""),arr:String(pick(a,"icao_code","icao")||""),aircraft:String(pick(ac,"icaocode","icao","name")||""),route:String(pick(g,"route")||""),cruiseAltitude:String(pick(g,"initial_altitude")||""),distance:asNumber(pick(g,"air_distance","distance")||0),duration:durationMinutes(pick(t,"est_time_enroute","sched_time")||0),departure:pick(t,"sched_out","est_out")||null,callsign:String(pick(at,"callsign")||""),source:"simbrief"};
 cache.s={at:Date.now(),data:f};return{configured:true,flight:f};
}
app.get("/health",(_,res)=>res.json({ok:true,service:"my-life-dashboard-api"}));
app.get("/api/integrations/status",(_,res)=>res.json({magister:Boolean(MAGISTER),newsky:Boolean(NEWSKY_ID),simbrief:Boolean(SIMBRIEF)}));
app.get("/api/magister/events",async(_,res)=>{try{res.json(await magister())}catch(e){res.status(502).json({configured:Boolean(MAGISTER),events:[],error:e.message})}});
app.get("/api/newsky/flights",async(_,res)=>{try{res.json(await newsky())}catch(e){res.status(502).json({configured:true,flights:[],error:e.message,diagnostics:e.diagnostics||[]})}});
app.get("/api/simbrief/latest",async(_,res)=>{try{res.json(await simbrief())}catch(e){res.status(502).json({configured:Boolean(SIMBRIEF),flight:null,error:e.message})}});
app.get("/api/dashboard/sync",async(_,res)=>{const x={syncedAt:new Date().toISOString(),magister:{events:[]},newsky:{flights:[]},simbrief:{flight:null}};await Promise.all([magister().then(v=>x.magister=v).catch(e=>x.magister={flights:[],error:e.message}),newsky().then(v=>x.newsky=v).catch(e=>x.newsky={flights:[],error:e.message,diagnostics:e.diagnostics||[]}),simbrief().then(v=>x.simbrief=v).catch(e=>x.simbrief={flight:null,error:e.message})]);res.json(x)});
app.listen(PORT,()=>console.log("My Life Dashboard API on "+PORT));