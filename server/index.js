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
 if(fresh(cache.n))return{configured:true,flights:cache.n.data};
 const urls=[
  "https://newsky.app/api/airline-api/flights/bydate?airlineId="+encodeURIComponent(NEWSKY_ID),
  "https://newsky.app/api/airline-api/flights/bydate?airline="+encodeURIComponent(NEWSKY_ID)
 ];
 let last;
 for(const u of urls)try{
  const r=await fetch(u,{headers:{accept:"application/json"}});if(!r.ok){last=Error("NewSky HTTP "+r.status);continue}
  const p=await r.json(),a=Array.isArray(p)?p:(p.flights||p.data||p.results||Object.values(p).find(Array.isArray)||[]);
  const flights=a.map(f=>({id:String(pick(f,"_id","id","flightId")||crypto.randomUUID()),flightNumber:String(pick(f,"flightNumber","callsign","flight_number")||""),dep:String(pick(f,"dep.icao","dep","departure.icao","departure")||""),arr:String(pick(f,"arr.icao","arr","arrival.icao","arrival")||""),aircraft:String(pick(f,"aircraft.icao","aircraft","airframe.icao","airframe")||""),duration:Number(pick(f,"duration","flightTime")||0),distance:Number(pick(f,"distance","distanceNm")||0),rating:Number(pick(f,"rating","score","stars")||0),date:pick(f,"date","depTime","departureTime","createdAt")||null,source:"newsky"}));
  cache.n={at:Date.now(),data:flights};return{configured:true,flights};
 }catch(e){last=e}
 throw last||Error("NewSky niet bereikbaar");
}
async function simbrief(){
 if(!SIMBRIEF)return{configured:false,flight:null};
 if(fresh(cache.s))return{configured:true,flight:cache.s.data};
 const u="https://www.simbrief.com/api/xml.fetcher.php?username="+encodeURIComponent(SIMBRIEF)+"&json=1";
 const r=await fetch(u);if(!r.ok)throw Error("SimBrief HTTP "+r.status);
 const d=await r.json(),g=d.general||{},o=d.origin||{},a=d.destination||{},ac=d.aircraft||{},t=d.times||{},at=d.atc||{};
 const f={id:String(pick(g,"static_id","flight_number")||Date.now()),flightNumber:String(pick(g,"flight_number")||""),dep:String(pick(o,"icao_code","icao")||""),arr:String(pick(a,"icao_code","icao")||""),aircraft:String(pick(ac,"icaocode","icao","name")||""),route:String(pick(g,"route")||""),cruiseAltitude:String(pick(g,"initial_altitude")||""),distance:Number(pick(g,"air_distance","distance")||0),duration:Number(pick(t,"est_time_enroute","sched_time")||0),departure:pick(t,"sched_out","est_out")||null,callsign:String(pick(at,"callsign")||""),source:"simbrief"};
 cache.s={at:Date.now(),data:f};return{configured:true,flight:f};
}
app.get("/health",(_,res)=>res.json({ok:true,service:"my-life-dashboard-api"}));
app.get("/api/integrations/status",(_,res)=>res.json({magister:Boolean(MAGISTER),newsky:Boolean(NEWSKY_ID),simbrief:Boolean(SIMBRIEF)}));
app.get("/api/magister/events",async(_,res)=>{try{res.json(await magister())}catch(e){res.status(502).json({configured:Boolean(MAGISTER),events:[],error:e.message})}});
app.get("/api/newsky/flights",async(_,res)=>{try{res.json(await newsky())}catch(e){res.status(502).json({configured:true,flights:[],error:e.message})}});
app.get("/api/simbrief/latest",async(_,res)=>{try{res.json(await simbrief())}catch(e){res.status(502).json({configured:Boolean(SIMBRIEF),flight:null,error:e.message})}});
app.get("/api/dashboard/sync",async(_,res)=>{const x={syncedAt:new Date().toISOString(),magister:{events:[]},newsky:{flights:[]},simbrief:{flight:null}};await Promise.all([magister().then(v=>x.magister=v).catch(e=>x.magister.error=e.message),newsky().then(v=>x.newsky=v).catch(e=>x.newsky.error=e.message),simbrief().then(v=>x.simbrief=v).catch(e=>x.simbrief.error=e.message)]);res.json(x)});
app.listen(PORT,()=>console.log("My Life Dashboard API on "+PORT));