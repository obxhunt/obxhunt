// Emails Drew a health alert about the listings refresh (sent from obxhunt-data via repository_dispatch).
// Needs secrets FAMILY_CODE and GMAIL_APP_PASSWORD. Logs show no message contents.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const CODE = (process.env.FAMILY_CODE || "").trim();
if (!CODE) { console.error("FAMILY_CODE secret is missing"); process.exit(1); }
const key = crypto.pbkdf2Sync(CODE, "obxhunt-v2", 150000, 32, "sha256");
const t = fs.readFileSync(path.join(ROOT, "data/key.enc.js"), "utf8");
const o = JSON.parse(t.match(/window\.__MAILENC=(\{[^;]*?\});/)[1]);
const b = Buffer.from(o.ct, "base64url"); const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(o.iv, "base64url")); d.setAuthTag(b.subarray(b.length - 16));
const mail = JSON.parse(Buffer.concat([d.update(b.subarray(0, b.length - 16)), d.final()]).toString("utf8"));

const subject = String(process.env.ALERT_SUBJECT || "OBX House Hunt: refresh health alert").slice(0, 200);
const text = String(process.env.ALERT_TEXT || "").slice(0, 5000) + "\n\nSite: https://obxhunt.github.io/obxhunt/\n";
const pass = (process.env.GMAIL_APP_PASSWORD || "").replace(/\s+/g, "");
if (!pass) { console.error("GMAIL_APP_PASSWORD secret is missing"); process.exit(1); }
const nodemailer = (await import("nodemailer")).default;
await nodemailer.createTransport({ service: "gmail", auth: { user: mail.from, pass } })
  .sendMail({ from: `OBX House Hunt <${mail.from}>`, to: mail.from, subject, text });
console.log("Health alert emailed");
