import React, { useEffect, useMemo, useState } from "react";
import dayjs from "dayjs";
import "dayjs/locale/pl";
import Holidays from "date-holidays";
import { auth, db, googleProvider } from "./firebase";
import {
  onAuthStateChanged, signInWithPopup, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, sendEmailVerification,
  sendPasswordResetEmail, signOut
} from "firebase/auth";
import { doc, getDoc, setDoc, serverTimestamp } from "firebase/firestore";

dayjs.locale("pl");
const hd = new Holidays("PL");

type MonthDoc = { days: number[]; requiredPercent: number; updatedAt?: any };

const startMonth = dayjs().month();
const startYear = dayjs().year();

export default function App() {
  const [user, setUser] = useState<null | { uid: string; email?: string | null }>(null);
  const [year, setYear] = useState(startYear);
  const [month, setMonth] = useState(startMonth);
  const [loading, setLoading] = useState(false);

  const [daysSelected, setDaysSelected] = useState<number[]>([]);
  const [requiredPercent, setRequiredPercent] = useState<number>(40);

  const yyyyMM = useMemo(() => dayjs(new Date(year, month, 1)).format("YYYY-MM"), [year, month]);

  useEffect(() => onAuthStateChanged(auth, u => setUser(u ? { uid: u.uid, email: u.email } : null)), []);

  useEffect(() => {
    const run = async () => {
      if (!user) return;
      setLoading(true);
      const ref = doc(db, "users", user.uid, "months", yyyyMM);
      const snap = await getDoc(ref);
      if (snap.exists()) {
        const d = snap.data() as MonthDoc;
        setDaysSelected(d.days || []);
        setRequiredPercent(d.requiredPercent ?? 40);
      } else {
        await setDoc(ref, { days: [], requiredPercent: 40, updatedAt: serverTimestamp() });
        setDaysSelected([]); setRequiredPercent(40);
      }
      setLoading(false);
    };
    run();
  }, [user, yyyyMM]);

  const today = dayjs();
  const firstDay = dayjs(new Date(year, month, 1));
  const daysInMonth = firstDay.daysInMonth();

  const holidaysSet = useMemo(() => {
    const list = hd.getHolidays(year)?.filter(h => h.type === "public")
      ?.map(h => dayjs(h.date).format("YYYY-MM-DD")) ?? [];
    return new Set(list);
  }, [year]);

  const isWeekend = (d: dayjs.Dayjs) => [0,6].includes(d.day());
  const isHoliday = (d: dayjs.Dayjs) => holidaysSet.has(d.format("YYYY-MM-DD"));

  const workdays = useMemo(() => {
    const arr: number[] = [];
    for (let i = 1; i <= daysInMonth; i++) {
      const dt = dayjs(new Date(year, month, i));
      if (!isWeekend(dt) && !isHoliday(dt)) arr.push(i);
    }
    return arr;
  }, [year, month, daysInMonth, holidaysSet]);

  const presentDays = daysSelected.filter(d => workdays.includes(d)).length;
  const percent = workdays.length ? (presentDays / workdays.length) * 100 : 0;
  const neededDays = Math.ceil((requiredPercent / 100) * workdays.length);
  const missing = Math.max(0, neededDays - presentDays);

  const toggleDay = async (day: number, dt: dayjs.Dayjs) => {
    if (!user) return;
    const isPast = dt.isBefore(today.startOf("day")) && dt.month()===today.month() && dt.year()===today.year();
    if (isPast || isWeekend(dt) || isHoliday(dt)) return;

    const next = daysSelected.includes(day)
      ? daysSelected.filter(x => x !== day)
      : [...daysSelected, day].sort((a,b)=>a-b);
    setDaysSelected(next);

    const ref = doc(db, "users", user.uid, "months", yyyyMM);
    await setDoc(ref, { days: next, requiredPercent, updatedAt: serverTimestamp() }, { merge: true });
  };

  const savePercent = async (val: number) => {
    setRequiredPercent(val);
    if (!user) return;
    const ref = doc(db, "users", user.uid, "months", yyyyMM);
    await setDoc(ref, { requiredPercent: val, updatedAt: serverTimestamp() }, { merge: true });
  };

  if (!user) return <AuthScreen
    onGoogle={()=>signInWithPopup(auth, googleProvider)}
    onEmailLogin={(e,p)=>signInWithEmailAndPassword(auth,e,p)}
    onEmailSignup={async (e,p)=>{ const r=await createUserWithEmailAndPassword(auth,e,p); try{await sendEmailVerification(r.user)}catch{} }}
    onForgot={(e)=>sendPasswordResetEmail(auth,e)}
  />;

  return (
    <div className="container">
      <div className="row" style={{justifyContent:'space-between', marginBottom:12}}>
        <h1>Obecność w biurze</h1>
        <div className="small">
          {user.email} &nbsp;•&nbsp;
          <button className="btn" onClick={()=>signOut(auth)}>Wyloguj</button>
        </div>
      </div>

      <div className="card" style={{marginBottom:12}}>
        <div className="row" style={{gap:12}}>
          <select value={month} onChange={e=>setMonth(parseInt(e.target.value))}>
            {Array.from({length:12}).map((_,i)=>(<option key={i} value={i}>{dayjs().month(i).format("MMMM")}</option>))}
          </select>
          <select value={year} onChange={e=>setYear(parseInt(e.target.value))}>
            {Array.from({length:5}).map((_,i)=>{const y=startYear-2+i; return <option key={y} value={y}>{y}</option>;})}
          </select>

          <div className="row" style={{marginLeft:'auto',gap:8}}>
            <label>Minimalna obecność %</label>
            <input className="input" type="number" min={0} max={100}
              value={requiredPercent}
              onChange={e=>savePercent(Math.max(0, Math.min(100, parseInt(e.target.value||"0"))))}/>
          </div>
        </div>
      </div>

      <div className="legend" style={{margin:"8px 0 12px"}}>
        <span><i className="dot pres"></i>Obecność</span>
        <span><i className="dot we"></i>Weekend</span>
        <span><i className="dot ho"></i>Święto</span>
      </div>

      <div className="card">
        {loading ? <div className="center">Ładowanie…</div> :
        <>
          <div className="grid" style={{marginBottom:8}}>
            {["Pon","Wt","Śr","Czw","Pt","Sob","Nd"].map(l=><div key={l} className="small center" style={{opacity:.7}}>{l}</div>)}
          </div>
          <div className="grid">
            {Array.from({length:(dayjs(new Date(year, month, 1)).day()+6)%7}).map((_,i)=><div key={"x"+i}></div>)}
            {Array.from({length:daysInMonth}).map((_,i)=>{
              const day=i+1; const dt=dayjs(new Date(year,month,day));
              const weekend=[0,6].includes(dt.day());
              const holiday=isHoliday(dt);
              const past=dt.isBefore(today.startOf("day")) && dt.month()===today.month() && dt.year()===today.year();
              const selected=daysSelected.includes(day);
              const cls=["day", weekend&&"weekend", holiday&&"holiday", past&&"past", selected&&"selected"].filter(Boolean).join(" ");
              return <div key={day} className={cls} onClick={()=>toggleDay(day,dt)}>{day}</div>;
            })}
          </div>
        </>}
      </div>

      <div className="row stats" style={{marginTop:12}}>
        <div className="stat">Dni robocze: <b>{workdays.length}</b></div>
        <div className="stat">Obecne dni: <b>{presentDays}</b></div>
        <div className="stat">Procent obecności: <b>{percent.toFixed(1)}%</b></div>
        <div className="stat">Min. liczba dni dla {requiredPercent}%: <b>{neededDays}</b></div>
        {missing>0 && <div className="stat">Brakuje: <b>{missing}</b></div>}
      </div>

      <div className="card" style={{marginTop:12}}>
        <div className="progress"><div className="bar" style={{width:`${Math.min(100, percent)}%`}}/></div>
      </div>
    </div>
  );
}

function AuthScreen({
  onGoogle, onEmailLogin, onEmailSignup, onForgot
}:{ onGoogle:()=>Promise<void>; onEmailLogin:(e:string,p:string)=>Promise<void>;
   onEmailSignup:(e:string,p:string)=>Promise<void>; onForgot:(e:string)=>Promise<void>; }) {
  const [email,setEmail]=useState(""); const [pwd,setPwd]=useState("");
  const [mode,setMode]=useState<"login"|"signup">("login");
  const [msg,setMsg]=useState("");

  const submit = async () => {
    setMsg("");
    try {
      if (mode==="login") await onEmailLogin(email,pwd);
      else { await onEmailSignup(email,pwd); setMsg("Konto utworzone. Sprawdź e-mail (wysłano weryfikację)."); }
    } catch (e:any) { setMsg(e.message || "Błąd"); }
  };
  const reset = async () => {
    if (!email) { setMsg("Podaj e-mail"); return; }
    try { await onForgot(email); setMsg("Wysłano link resetu hasła."); } catch (e:any) { setMsg(e.message || "Błąd"); }
  };

  return (
    <div className="container" style={{maxWidth:460}}>
      <div className="card">
        <h1 className="center">Sign up / Log in</h1>
        <div className="row" style={{justifyContent:"center", margin:"12px 0"}}>
          <button className="btn btn-brand" onClick={onGoogle}>Zaloguj przez Google</button>
        </div>
        <div style={{height:1, background:"#2b3346", margin:"10px 0 14px"}}/>
        <div className="row" style={{flexDirection:"column", gap:8}}>
          <input className="input" placeholder="Email" value={email} onChange={e=>setEmail(e.target.value)} />
          <input className="input" placeholder="Hasło" type="password" value={pwd} onChange={e=>setPwd(e.target.value)} />
          <button className="btn" onClick={submit}>{mode==="login" ? "Zaloguj" : "Utwórz konto"}</button>
          <div className="small">
            {mode==="login" ? <>Nie masz konta? <a href="#" onClick={()=>setMode("signup")}>Zarejestruj się</a> • <a href="#" onClick={reset}>Nie pamiętasz hasła?</a></>
            : <>Masz konto? <a href="#" onClick={()=>setMode("login")}>Zaloguj się</a></>}
          </div>
          {msg && <div className="small" style={{color:"#9ae6b4"}}>{msg}</div>}
        </div>
      </div>
    </div>
  );
}
