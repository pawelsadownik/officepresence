import { useEffect, useMemo, useState } from "react";
import dayjs from "dayjs";
import "dayjs/locale/pl";
import Holidays from "date-holidays";
import { auth, db, googleProvider } from "./firebase";
import {
  onAuthStateChanged,
  signInWithPopup,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  sendEmailVerification,
  sendPasswordResetEmail,
  signOut,
} from "firebase/auth";
import { doc, getDoc, setDoc, serverTimestamp } from "firebase/firestore";

dayjs.locale("pl");
const hd = new Holidays("PL");

type DayStatus = "office" | "excused";
type Mark = { d: number; status: DayStatus };

type MonthDoc = {
  marks?: Mark[];
  days?: number[];                 // stary format (migracja -> office)
  requiredPercent: number;
  employmentPercent?: number;      // NOWE: wymiar pracy w %
  updatedAt?: any;
};

const startMonth = dayjs().month();
const startYear = dayjs().year();

export default function App() {
  const [user, setUser] = useState<null | { uid: string; email?: string | null }>(null);
  const [year, setYear] = useState(startYear);
  const [month, setMonth] = useState(startMonth);
  const [loading, setLoading] = useState(false);

  const [marks, setMarks] = useState<Mark[]>([]);
  const [requiredPercent, setRequiredPercent] = useState<number>(40);
  const [employmentPercent, setEmploymentPercent] = useState<number>(100); // NOWE

  const yyyyMM = useMemo(() => dayjs(new Date(year, month, 1)).format("YYYY-MM"), [year, month]);

  // auth
  useEffect(() => onAuthStateChanged(auth, (u) => setUser(u ? { uid: u.uid, email: u.email } : null)), []);

  // load month doc
  useEffect(() => {
    const run = async () => {
      if (!user) return;
      setLoading(true);
      try {
        const ref = doc(db, "users", user.uid, "months", yyyyMM);
        const snap = await getDoc(ref);
        if (snap.exists()) {
          const d = snap.data() as MonthDoc;
          if (Array.isArray(d.marks)) setMarks(d.marks);
          else if (Array.isArray(d.days)) setMarks(d.days.map((n) => ({ d: n, status: "office" as const })));
          else setMarks([]);
          setRequiredPercent(d.requiredPercent ?? 40);
          setEmploymentPercent(d.employmentPercent ?? 100); // NOWE
        } else {
          await setDoc(ref, {
            marks: [],
            requiredPercent: 40,
            employmentPercent: 100,     // NOWE
            updatedAt: serverTimestamp(),
          });
          setMarks([]);
          setRequiredPercent(40);
          setEmploymentPercent(100);
        }
      } finally {
        setLoading(false);
      }
    };
    run();
  }, [user, yyyyMM]);

  // calendar helpers
  const today = dayjs();
  const firstDay = dayjs(new Date(year, month, 1));
  const daysInMonth = firstDay.daysInMonth();

  const holidaysSet = useMemo(() => {
    const list =
      hd.getHolidays(year)?.filter((h: any) => h.type === "public")?.map((h: any) => dayjs(h.date).format("YYYY-MM-DD")) ??
      [];
    return new Set(list);
  }, [year]);

  const isWeekend = (d: dayjs.Dayjs) => [0, 6].includes(d.day());
  const isHoliday = (d: dayjs.Dayjs) => holidaysSet.has(d.format("YYYY-MM-DD"));

  const getStatus = (arr: Mark[], day: number) => arr.find((m) => m.d === day)?.status as DayStatus | undefined;
  const setStatus = (arr: Mark[], day: number, status?: DayStatus): Mark[] => {
    const filtered = arr.filter((m) => m.d !== day);
    return status ? [...filtered, { d: day, status }].sort((a, b) => a.d - b.d) : filtered;
  };
  // 3-stanowy cykl: none -> office -> excused -> none
  const nextStatus3 = (current?: DayStatus): DayStatus | undefined => {
    if (!current) return "office";
    if (current === "office") return "excused";
    return undefined;
  };

  const handleDayClick = async (day: number, dt: dayjs.Dayjs) => {
    if (!user) return;
    if (isWeekend(dt) || isHoliday(dt)) return;

    const past = dt.isBefore(today.startOf("day")) && dt.month() === today.month() && dt.year() === today.year();
    if (past) return;

    const current = getStatus(marks, day);
    const next = nextStatus3(current);
    const nextMarks = setStatus(marks, day, next);
    setMarks(nextMarks);

    const ref = doc(db, "users", user.uid, "months", yyyyMM);
    await setDoc(
      ref,
      { marks: nextMarks, requiredPercent, employmentPercent, updatedAt: serverTimestamp() },
      { merge: true }
    );
  };

  const savePercent = async (val: number) => {
    const v = Math.max(0, Math.min(100, val));
    setRequiredPercent(v);
    if (!user) return;
    const ref = doc(db, "users", user.uid, "months", yyyyMM);
    await setDoc(ref, { requiredPercent: v, updatedAt: serverTimestamp() }, { merge: true });
  };

  // NOWE: zapis wymiaru pracy
  const saveEmployment = async (val: number) => {
    const v = Math.max(0, Math.min(100, val));
    setEmploymentPercent(v);
    if (!user) return;
    const ref = doc(db, "users", user.uid, "months", yyyyMM);
    await setDoc(ref, { employmentPercent: v, updatedAt: serverTimestamp() }, { merge: true });
  };

  // stats
  const excusedSet = useMemo(() => new Set(marks.filter((m) => m.status === "excused").map((m) => m.d)), [marks]);

  const workdays = useMemo(() => {
    const arr: number[] = [];
    for (let i = 1; i <= daysInMonth; i++) {
      const dt = dayjs(new Date(year, month, i));
      if (!isWeekend(dt) && !isHoliday(dt) && !excusedSet.has(i)) arr.push(i);
    }
    return arr;
  }, [year, month, daysInMonth, holidaysSet, excusedSet]);

  const presentDays = marks.filter((m) => m.status === "office" && workdays.includes(m.d)).length;

  // najpierw próg dla pełnego etatu, potem skala wymiaru
  const baseNeeded = Math.round((requiredPercent / 100) * workdays.length);
  const neededDays = Math.round(baseNeeded * (employmentPercent / 100));   // <= tu uwzględniamy wymiar pracy
  const percent = workdays.length ? (presentDays / workdays.length) * 100 : 0;
  const missing = Math.max(0, neededDays - presentDays);

  if (!user)
    return (
      <AuthScreen
        onGoogle={async () => {
          await signInWithPopup(auth, googleProvider);
        }}
        onEmailLogin={async (e, p) => {
          await signInWithEmailAndPassword(auth, e, p);
        }}
        onEmailSignup={async (e, p) => {
          const r = await createUserWithEmailAndPassword(auth, e, p);
          try {
            await sendEmailVerification(r.user);
          } catch {}
        }}
        onForgot={async (e) => {
          await sendPasswordResetEmail(auth, e);
        }}
      />
    );

  return (
    <div className="container">
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 12 }}>
        <h1>Obecność w biurze</h1>
      </div>

      <div className="card" style={{ marginBottom: 12 }}>
        <div className="row" style={{ gap: 12 }}>
          <select value={month} onChange={(e) => setMonth(parseInt(e.target.value))}>
            {Array.from({ length: 12 }).map((_, i) => (
              <option key={i} value={i}>
                {dayjs().month(i).format("MMMM")}
              </option>
            ))}
          </select>
          <select value={year} onChange={(e) => setYear(parseInt(e.target.value))}>
            {Array.from({ length: 5 }).map((_, i) => {
              const y = startYear - 2 + i;
              return (
                <option key={y} value={y}>
                  {y}
                </option>
              );
            })}
          </select>

          {/* Ustawienia po prawej */}
          <div className="row" style={{ marginLeft: "auto", gap: 8 }}>
            <label>Minimalna obecność %</label>
            <input
              className="input"
              type="number"
              min={0}
              max={100}
              value={requiredPercent}
              onChange={(e) => savePercent(parseInt(e.target.value || "0"))}
              style={{ width: 90 }}
            />

            {/* NOWE pole: Wymiar pracy % */}
            <label>Wymiar pracy %</label>
            <input
              className="input"
              type="number"
              min={0}
              max={100}
              value={employmentPercent}
              onChange={(e) => saveEmployment(parseInt(e.target.value || "0"))}
              style={{ width: 90 }}
            />
          </div>
        </div>
      </div>

      <div className="legend" style={{ margin: "8px 0 12px" }}>
        <span><i className="dot pres"></i>Obecność</span>
        <span><i className="dot we"></i>Weekend</span>
        <span><i className="dot ho"></i>Święto</span>
        <span><i className="dot exc"></i>Urlop/Choroba</span>
      </div>

      <div className="card">
        {loading ? (
          <div className="center">Ładowanie…</div>
        ) : (
          <>
            <div className="grid" style={{ marginBottom: 8 }}>
              {["Pon", "Wt", "Śr", "Czw", "Pt", "Sob", "Nd"].map((l) => (
                <div key={l} className="small center" style={{ opacity: 0.7 }}>
                  {l}
                </div>
              ))}
            </div>
            <div className="grid">
              {Array.from({ length: (dayjs(new Date(year, month, 1)).day() + 6) % 7 }).map((_, i) => (
                <div key={"x" + i}></div>
              ))}
              {Array.from({ length: daysInMonth }).map((_, i) => {
                const day = i + 1;
                const dt = dayjs(new Date(year, month, day));
                const weekend = isWeekend(dt);
                const holiday = isHoliday(dt);
                const past =
                  dt.isBefore(dayjs().startOf("day")) &&
                  dt.month() === dayjs().month() &&
                  dt.year() === dayjs().year();

                const status = getStatus(marks, day);
                const isOffice = status === "office";
                const isExcused = status === "excused";

                const cls = ["day", weekend && "weekend", holiday && "holiday", past && "past", isOffice && "selected", isExcused && "excused"]
                  .filter(Boolean)
                  .join(" ");

                return (
                  <div key={day} className={cls} onClick={() => handleDayClick(day, dt)}>
                    {day}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>

      <div className="row stats" style={{ marginTop: 12 }}>
        <div className="stat">Dni robocze: <b>{workdays.length}</b></div>
        <div className="stat">Obecne dni: <b>{presentDays}</b></div>
        <div className="stat">Procent obecności: <b>{percent.toFixed(1)}%</b></div>
        <div className="stat">Min. dni dla {requiredPercent}% (przy {employmentPercent}% etatu): <b>{neededDays}</b></div>
        {missing > 0 && <div className="stat">Brakuje: <b>{missing}</b></div>}
      </div>

      <div className="card" style={{ marginTop: 12 }}>
        <div className="progress">
          <div className="bar" style={{ width: `${Math.min(100, percent)}%` }} />
        </div>
      </div>

      <footer className="footer-logout">
        <span>{user.email}</span>
        <button className="btn" onClick={() => signOut(auth)}>Wyloguj</button>
      </footer>
    </div>
  );
}

function AuthScreen({
  onGoogle,
  onEmailLogin,
  onEmailSignup,
  onForgot,
}: {
  onGoogle: () => Promise<unknown>;
  onEmailLogin: (e: string, p: string) => Promise<unknown>;
  onEmailSignup: (e: string, p: string) => Promise<unknown>;
  onForgot: (e: string) => Promise<unknown>;
}) {
  const [email, setEmail] = useState("");
  const [pwd, setPwd] = useState("");
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [msg, setMsg] = useState("");

  const submit = async () => {
    setMsg("");
    try {
      if (mode === "login") await onEmailLogin(email, pwd);
      else {
        await onEmailSignup(email, pwd);
        setMsg("Konto utworzone. Sprawdź e-mail (wysłano weryfikację).");
      }
    } catch (e: any) {
      setMsg(e.message || "Błąd");
    }
  };
  const reset = async () => {
    if (!email) {
      setMsg("Podaj e-mail");
      return;
    }
    try {
      await onForgot(email);
      setMsg("Wysłano link resetu hasła.");
    } catch (e: any) {
      setMsg(e.message || "Błąd");
    }
  };

  return (
    <div className="container" style={{ maxWidth: 460 }}>
      <div className="card">
        <h1 className="center">Sign up / Log in</h1>
        <div className="row" style={{ justifyContent: "center", margin: "12px 0" }}>
          <button className="btn btn-brand" onClick={onGoogle}>
            Zaloguj przez Google
          </button>
        </div>
        <div style={{ height: 1, background: "#2b3346", margin: "10px 0 14px" }} />
        <div className="row" style={{ flexDirection: "column", gap: 8 }}>
          <input className="input" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <input className="input" placeholder="Hasło" type="password" value={pwd} onChange={(e) => setPwd(e.target.value)} />
          <button className="btn" onClick={submit}>{mode === "login" ? "Zaloguj" : "Utwórz konto"}</button>
          <div className="small">
            {mode === "login" ? (
              <>Nie masz konta? <a href="#" onClick={() => setMode("signup")}>Zarejestruj się</a> • <a href="#" onClick={reset}>Nie pamiętasz hasła?</a></>
            ) : (
              <>Masz konto? <a href="#" onClick={() => setMode("login")}>Zaloguj się</a></>
            )}
          </div>
          {msg && <div className="small" style={{ color: "#9ae6b4" }}>{msg}</div>}
        </div>
      </div>
    </div>
  );
}
