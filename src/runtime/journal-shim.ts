// The guest prelude a journaled QuickJS run evaluates first, kept free of Node
// modules so the durable extension can use it in a Worker (see exec-journal.ts).

/** Guest prelude that removes the nondeterminism replay cannot reproduce. */
export const journalShimSource = (seed: number): string => `
(() => {
const __now = globalThis.__fabricJournalNow;
delete globalThis.__fabricJournalNow;
let __s = ${seed >>> 0} >>> 0;
const random = () => {
  __s = (__s + 0x6D2B79F5) >>> 0;
  let t = __s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
Object.defineProperty(Math, "random", { value: random, writable: true, configurable: true });
delete globalThis.WeakRef;
delete globalThis.FinalizationRegistry;
const D = globalThis.Date;
const P = D.prototype;
const getTime = P.getTime;
const tzo = P.getTimezoneOffset;
const W = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
const M = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const p2 = (n) => String(n).padStart(2, "0");
const yr = (y) => y < 0 ? "-" + String(-y).padStart(4, "0") : String(y).padStart(4, "0");
const ymd = (d) => W[d.getUTCDay()] + " " + M[d.getUTCMonth()] + " " + p2(d.getUTCDate()) + " " + yr(d.getUTCFullYear());
const hms = (d) => p2(d.getUTCHours()) + ":" + p2(d.getUTCMinutes()) + ":" + p2(d.getUTCSeconds());
const ldate = (d) => p2(d.getUTCMonth() + 1) + "/" + p2(d.getUTCDate()) + "/" + yr(d.getUTCFullYear());
const ltime = (d) => { const h = d.getUTCHours(); return p2(h % 12 === 0 ? 12 : h % 12) + ":" + p2(d.getUTCMinutes()) + ":" + p2(d.getUTCSeconds()) + (h < 12 ? " AM" : " PM"); };
const define = (target, name, value) => Object.defineProperty(target, name, { value, writable: true, configurable: true });
const text = (format) => function () { return Number.isNaN(getTime.call(this)) ? "Invalid Date" : format(this); };
for (const [local, utc] of [["getFullYear","getUTCFullYear"],["getMonth","getUTCMonth"],["getDate","getUTCDate"],["getDay","getUTCDay"],["getHours","getUTCHours"],["getMinutes","getUTCMinutes"],["getSeconds","getUTCSeconds"],["getMilliseconds","getUTCMilliseconds"],["setFullYear","setUTCFullYear"],["setMonth","setUTCMonth"],["setDate","setUTCDate"],["setHours","setUTCHours"],["setMinutes","setUTCMinutes"],["setSeconds","setUTCSeconds"],["setMilliseconds","setUTCMilliseconds"]]) define(P, local, P[utc]);
if (typeof P.getYear === "function") define(P, "getYear", function () { return P.getUTCFullYear.call(this) - 1900; });
define(P, "getTimezoneOffset", function () { return Number.isNaN(getTime.call(this)) ? NaN : 0; });
define(P, "toString", text((d) => ymd(d) + " " + hms(d) + " GMT+0000"));
define(P, "toDateString", text(ymd));
define(P, "toTimeString", text((d) => hms(d) + " GMT+0000"));
define(P, "toLocaleString", text((d) => ldate(d) + ", " + ltime(d)));
define(P, "toLocaleDateString", text(ldate));
define(P, "toLocaleTimeString", text(ltime));
const utcForm = (s) => /(?:Z|[+-]\\d\\d:?\\d\\d|GMT|UTC)(?:\\s*\\(.*\\))?$/i.test(s) || /^[+-]?\\d{4,6}(?:-\\d\\d(?:-\\d\\d)?)?$/.test(s);
const parse = (value) => {
  const s = String(value).trim();
  const t = D.parse(s);
  if (Number.isNaN(t) || utcForm(s)) return t;
  return t - tzo.call(new D(t)) * 60000;
};
function Date(...args) {
  if (new.target === undefined) return P.toString.call(new D(__now()));
  let d;
  if (args.length === 0) d = new D(__now());
  else if (args.length === 1) {
    const v = args[0];
    d = new D(typeof v === "string" ? parse(v) : v instanceof D ? getTime.call(v) : v);
  } else d = new D(D.UTC(...args));
  if (new.target !== Date) Object.setPrototypeOf(d, new.target.prototype);
  return d;
}
Date.prototype = P;
define(P, "constructor", Date);
Object.defineProperty(Date, "length", { value: 7, configurable: true });
define(Date, "now", () => __now());
define(Date, "parse", parse);
define(Date, "UTC", D.UTC);
define(globalThis, "Date", Date);
})();
`;
