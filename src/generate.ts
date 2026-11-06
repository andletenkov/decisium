// Generated values: `{{fn[:label] [args]}}` inside a Step's quotes, doc string or table cells (docs/site/steps.md, Generated
// values). Each function+label+args gets one value per run, typed for the template and masked back to it in every
// Observation, so the model and cassette only see the template. Random values derive from the run's seed (shared by
// parallel workers through the environment); dates and `unique` from the run's start time.
import { createHash, randomBytes } from "node:crypto";

const TEMPLATE = /\{\{[^{}]*\}\}/g;
const SYNTAX = /^\{\{\s*([a-z]+)(?::(\w+))?((?:\s+[^{}\s]+)*)\s*\}\}$/;
const MAX_TEXT = 1_000_000;

/** The `{{...}}` templates in a string, as written, in order. */
export const templates = (s: string): string[] => [...s.matchAll(TEMPLATE)].map((m) => m[0]);

/** A fresh seed for a run. */
export const newSeed = () => randomBytes(6).toString("hex");

const pad = (n: number) => String(n).padStart(2, "0");
const UNITS: Record<string, (d: Date, n: number) => void> = {
  s: (d, n) => d.setSeconds(d.getSeconds() + n),
  m: (d, n) => d.setMinutes(d.getMinutes() + n),
  h: (d, n) => d.setHours(d.getHours() + n),
  d: (d, n) => d.setDate(d.getDate() + n),
  w: (d, n) => d.setDate(d.getDate() + 7 * n),
  M: (d, n) => d.setMonth(d.getMonth() + n),
  y: (d, n) => d.setFullYear(d.getFullYear() + n),
};

function formatDate(d: Date, format: string): string {
  const parts: Record<string, string> = {
    YYYY: String(d.getFullYear()),
    MM: pad(d.getMonth() + 1),
    DD: pad(d.getDate()),
    HH: pad(d.getHours()),
    mm: pad(d.getMinutes()),
    ss: pad(d.getSeconds()),
  };
  return format.replace(/YYYY|MM|DD|HH|mm|ss/g, (t) => parts[t]);
}

const whole = (s: string | undefined) => (s !== undefined && /^-?\d+$/.test(s) ? Number(s) : undefined);

/** The run's generator: one value per function, label and args, from `seed` and the run's `start` (ms). */
export class Generated {
  private seed: string;
  private start: number;
  private cache = new Map<string, string>();
  constructor(seed: string, start: number) {
    this.seed = seed;
    this.start = start;
  }

  /** template -> value for every template in `texts`. Throws on an unknown function or bad args, naming the template. */
  values(texts: string[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (const text of texts)
      for (const [template] of text.matchAll(TEMPLATE)) {
        const m = SYNTAX.exec(template);
        if (!m) throw new Error(`${template}: unknown function or bad arguments (see Generated values)`);
        const [, fn, label = "", rest] = m;
        const args = rest.trim() ? rest.trim().split(/\s+/) : [];
        const key = [fn, label, ...args].join("\0");
        if (!this.cache.has(key)) {
          const value = this.make(fn, args, this.hash(key));
          if (value === undefined)
            throw new Error(`${template}: unknown function or bad arguments (see Generated values)`);
          this.cache.set(key, value);
        }
        out[template] = this.cache.get(key)!;
      }
    return out;
  }

  private hash(key: string) {
    return createHash("sha256").update(`${this.seed}\0${key}`).digest();
  }

  private make(fn: string, args: string[], h: Buffer): string | undefined {
    const unique = () => this.start.toString(36) + (h.readUIntBE(0, 3) % 36 ** 4).toString(36).padStart(4, "0");
    switch (fn) {
      case "unique":
        return args.length ? undefined : unique();
      case "email":
        return args.length ? undefined : `autotest+${unique()}@example.com`;
      case "uuid": {
        if (args.length) return undefined;
        const b = Buffer.from(h.subarray(0, 16));
        b[6] = (b[6] & 0x0f) | 0x40;
        b[8] = (b[8] & 0x3f) | 0x80;
        const x = b.toString("hex");
        return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
      }
      case "number": {
        const [min, max] = args.length ? args.map(whole) : [100000, 999999];
        if (args.length > 2 || min === undefined || max === undefined || min > max) return undefined;
        return String(min + (h.readUIntBE(0, 6) % (max - min + 1)));
      }
      case "timestamp":
        return args.length ? undefined : String(this.start);
      case "text": {
        const n = whole(args[0]);
        const ch = args[1] ?? "a";
        if (
          n === undefined ||
          !Number.isSafeInteger(n) ||
          n < 0 ||
          n > MAX_TEXT ||
          args.length > 2 ||
          [...ch].length !== 1
        )
          return undefined;
        return ch.repeat(n);
      }
      case "date":
      case "datetime": {
        const d = new Date(this.start);
        let rest = args;
        const shift = /^([+-]\d+)([smhdwMy])$/.exec(rest[0] ?? "");
        if (shift) {
          UNITS[shift[2]](d, Number(shift[1]));
          rest = rest.slice(1);
        } else if (/^[+-]/.test(rest[0] ?? "")) return undefined;
        const format = rest.join(" ") || (fn === "date" ? "YYYY-MM-DD" : "YYYY-MM-DDTHH:mm");
        if (!/YYYY|MM|DD|HH|mm|ss/.test(format) || /[a-zA-Z]/.test(format.replace(/YYYY|MM|DD|HH|mm|ss|T/g, "")))
          return undefined;
        return formatDate(d, format);
      }
    }
    return undefined;
  }
}

/** `value` with each template replaced by its value from `values`; other text untouched. */
export const fill = (value: string, values: Record<string, string>): string =>
  value.replace(TEMPLATE, (t) => values[t] ?? t);
