// Per-person new-listing and price-drop alerts. Runs in GitHub Actions after each listings publish.
// Each person's email and filters live in the private data repo (people/<id>.json),
// edited on the site's Users page. Already-sent listings are tracked in alerts/sent.json there.
// Needs secrets FAMILY_CODE and GMAIL_APP_PASSWORD. Logs show counts only.
// Local preview: DATA_DIR=<folder with people/> OUT=<folder> node tools/listing-alerts.mjs
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const SITE = "https://obxhunt.github.io/obxhunt/";
const CODE = (process.env.FAMILY_CODE || "").trim();
if (!CODE) { console.error("FAMILY_CODE secret is missing"); process.exit(1); }
const key = crypto.pbkdf2Sync(CODE, "obxhunt-v2", 150000, 32, "sha256");
const dec = o => { const b = Buffer.from(o.ct, "base64url"); const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(o.iv, "base64url")); d.setAuthTag(b.subarray(b.length - 16)); return Buffer.concat([d.update(b.subarray(0, b.length - 16)), d.final()]).toString("utf8"); };
const grab = (file, name) => { const t = fs.readFileSync(path.join(ROOT, file), "utf8"); const m = t.match(new RegExp("window\\." + name + "=(\\{[^;]*?\\});")); return m ? JSON.parse(m[1]) : null; };

const snap = JSON.parse(dec(grab("data/listings.enc.js", "__ENC")));
const token = dec(grab("data/key.enc.js", "__TOKENC"));
const mail = JSON.parse(dec(grab("data/key.enc.js", "__MAILENC")));
const API = "https://api.github.com/repos/obxhunt/obxhunt-data";
const H = { Authorization: "Bearer " + token, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };

async function getJson(p) {
  if (process.env.DATA_DIR) { const f = path.join(process.env.DATA_DIR, p); return fs.existsSync(f) ? { data: JSON.parse(fs.readFileSync(f, "utf8")), sha: null } : null; }
  const r = await fetch(API + "/contents/" + p + "?ref=main", { headers: H });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error("Couldn't read " + p.split("/")[0] + ": HTTP " + r.status);
  const j = await r.json(); return { data: JSON.parse(Buffer.from(j.content, "base64").toString("utf8")), sha: j.sha };
}
async function listDir(dir) {
  if (process.env.DATA_DIR) { const d = path.join(process.env.DATA_DIR, dir); return fs.existsSync(d) ? fs.readdirSync(d).filter(f => f.endsWith(".json")) : []; }
  const r = await fetch(API + "/contents/" + dir + "?ref=main", { headers: H });
  if (r.status === 404) return [];
  if (!r.ok) throw new Error("Couldn't list " + dir + ": HTTP " + r.status);
  return (await r.json()).filter(e => e.type === "file" && e.name.endsWith(".json")).map(e => e.name);
}
async function putJson(p, data, sha, message) {
  if (process.env.DATA_DIR) { const f = path.join(process.env.DATA_DIR, p); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(data)); return; }
  const body = { message, content: Buffer.from(JSON.stringify(data)).toString("base64"), branch: "main" }; if (sha) body.sha = sha;
  const r = await fetch(API + "/contents/" + p, { method: "PUT", headers: Object.assign({ "Content-Type": "application/json" }, H), body: JSON.stringify(body) });
  if (!r.ok) throw new Error("Couldn't write " + p.split("/")[0] + ": HTTP " + r.status);
}
const putSent = (data, sha) => putJson("alerts/sent.json", data, sha, "Record listing alerts sent");

const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const money = n => n ? "$" + Math.round(n).toLocaleString("en-US") : "—";
const kmoney = n => n >= 1e6 ? "$" + (n / 1e6).toFixed(n % 1e6 ? 2 : 0).replace(/\.?0+$/, "") + "M" : "$" + Math.round(n / 1000) + "k";
const FEED = { 6: "NC_OBAR", 8: "VA_REIN", 9: "NC_CCAR" };
const photo = l => { const m = String(l.mls || ""); return /^\d+$/.test(m) && FEED[m.length] ? `https://images-listings.coldwellbanker.com/${FEED[m.length]}/${m.match(/.{1,2}/g).join("/")}/_P/${m}_P00.jpg` : ""; };
const zillow = l => "https://www.zillow.com/homes/" + encodeURIComponent([l.address, l.town, "NC", l.zip || ""].join(" ").trim().replace(/\s+/g, "-")).replace(/%2C/g, "") + "_rb/";
const facts = l => l.kind === "lot" ? (l.acres ? l.acres + " ac" : "") : [l.beds ? l.beds + " bd" : "", l.baths ? l.baths + " ba" : "", l.sqft ? l.sqft.toLocaleString("en-US") + " sq ft" : "", l.acres ? l.acres + " ac" : ""].filter(Boolean).join(" · ");
const KIND = { house: "House", condo: "Condo / townhome", lot: "Lot" };
const FRF = { lat: 36.18297, lng: -75.74802 };
const miles = l => { if (l.lat == null) return null; const R = 3958.8, t = x => x * Math.PI / 180; const a = Math.sin(t(l.lat - FRF.lat) / 2) ** 2 + Math.cos(t(FRF.lat)) * Math.cos(t(l.lat)) * Math.sin(t(l.lng - FRF.lng) / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(a)); };
const link = id => SITE + "#" + CODE + "&l=" + encodeURIComponent(id);

function matches(a, l) {
  if (a.kinds && a.kinds.length && !a.kinds.includes(l.kind)) return false;
  if (a.towns && a.towns.length && !a.towns.includes(l.area || l.town)) return false;
  if (a.pmin && !(l.price >= a.pmin)) return false;
  if (a.pmax && !(l.price <= a.pmax)) return false;
  if (a.beds && !((l.beds || 0) >= a.beds)) return false;
  if (a.baths && !((l.baths || 0) >= a.baths)) return false;
  if (a.radius) { const d = miles(l); if (d == null || d > a.radius) return false; }
  return true;
}
function describe(a) {
  const k = a.kinds && a.kinds.length && a.kinds.length < 3 ? a.kinds.map(x => ({ house: "houses", condo: "condos", lot: "lots" })[x]).join(" & ") : "all listings";
  const p = [k]; if (a.towns && a.towns.length) p.push("in " + a.towns.join(", ")); if (a.radius) p.push(`within ${a.radius} mi of FRF`);
  if (a.pmin && a.pmax) p.push(`${kmoney(a.pmin)}–${kmoney(a.pmax)}`); else if (a.pmax) p.push("under " + kmoney(a.pmax)); else if (a.pmin) p.push(kmoney(a.pmin) + " and up");
  if (a.beds) p.push(a.beds + "+ bed"); if (a.baths) p.push(a.baths + "+ bath"); return p.join(", ");
}

// ---- which listings are new ----
const SEED_DATE = process.env.SEED_DATE || "2026-10-19"; // the first full load isn't "new"
const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const since = new Date(Date.now() - 3 * 864e5).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const fresh = Object.entries(snap.items).map(([id, l]) => Object.assign({ id }, l))
  .filter(l => { const d = String(l.addedAt || "").slice(0, 10); return d >= since && d > SEED_DATE && (l.addedBy || "Claude") === "Claude" && (l.status || "Active") === "Active"; });

const people = [];
for (const f of await listDir("people")) { const d = await getJson("people/" + f); if (d) people.push(Object.assign({ id: f.slice(0, -5) }, d.data)); }
const sentDoc = await getJson("alerts/sent.json");
const sent = (sentDoc && sentDoc.data) || {};
console.log(`${fresh.length} new listing(s) in the last 3 days; ${people.filter(p => p.alerts && p.alerts.on && p.email).length} person(s) with new-listing alerts on, ${people.filter(p => p.alerts && p.alerts.drops && p.email).length} with price-drop alerts on`);

const OUT = process.env.OUT; if (OUT) fs.mkdirSync(OUT, { recursive: true });
let tx = null, emailed = 0, changed = false;
for (const p of people) {
  const a = p.alerts || {}; if (!a.on || !p.email) continue;
  const mine = sent[p.id] || (sent[p.id] = {});
  const hits = fresh.filter(l => !mine[l.id] && matches(a, l)).sort((x, y) => (x.price || 0) - (y.price || 0));
  if (!hits.length) continue;
  const name = String(p.name || p.id).replace(/ \(shared\)$/, "");
  const subject = `OBX alert: ${hits.length === 1 ? `new listing, ${hits[0].address} (${kmoney(hits[0].price)})` : `${hits.length} new listings that match`}`;
  const row = l => { const ph = photo(l); return `<tr><td style="padding:0 0 14px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fff;border:1px solid #e3ddd0;border-radius:12px;overflow:hidden">
    ${ph ? `<tr><td><a href="${esc(link(l.id))}"><img src="${esc(ph)}" width="560" alt="" style="display:block;width:100%;max-width:560px;height:auto;border:0"></a></td></tr>` : ""}
    <tr><td style="padding:12px 16px 14px;font-family:Helvetica,Arial,sans-serif;color:#17263a">
      <div style="font-size:22px;font-weight:700">${money(l.price)}</div>
      <div style="font-size:16px;font-weight:600;margin-top:2px">${esc(l.address)}</div>
      <div style="font-size:13px;color:#5b6675;margin-top:2px">${esc(l.area || l.town || "")} · ${esc(KIND[l.kind] || "")}${facts(l) ? " · " + esc(facts(l)) : ""}${miles(l) != null ? ` · ${miles(l).toFixed(1)} mi from FRF` : ""}</div>
      <div style="margin-top:10px;font-size:14px"><a href="${esc(link(l.id))}" style="color:#b3157c;font-weight:700;text-decoration:none">Open on the map</a> &nbsp;·&nbsp; <a href="${esc(zillow(l))}" style="color:#17263a;text-decoration:none">All photos on Zillow</a></div>
    </td></tr></table></td></tr>`; };
  const html = `<!doctype html><html><body style="margin:0;background:#f3f0e8"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f0e8"><tr><td align="center" style="padding:20px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px">
<tr><td style="font-family:Helvetica,Arial,sans-serif;color:#17263a;padding:0 0 16px">
  <div style="font-size:13px;letter-spacing:.12em;text-transform:uppercase;color:#b3157c;font-weight:700">OBX House Hunt</div>
  <div style="font-size:26px;font-weight:800;margin-top:2px">New listing${hits.length === 1 ? "" : "s"} for ${esc(name)}</div>
  <div style="font-size:14px;color:#5b6675;margin-top:4px">Your alert: ${esc(describe(a))}</div>
</td></tr>${hits.map(row).join("")}
<tr><td style="font-family:Helvetica,Arial,sans-serif;font-size:11.5px;color:#7a8390;padding:6px 0 20px">You get this because ${esc(name)}'s email alert is on. Change or turn it off on the site's Users page. Listing photos courtesy of the listing brokers. The map link is private, so please don't forward it.</td></tr>
</table></td></tr></table></body></html>`;
  const text = `New listings for ${name} (${describe(a)})\n\n` + hits.map(l => `${money(l.price)}  ${l.address} (${l.area || l.town})  ${facts(l)}\n  ${link(l.id)}`).join("\n\n") + "\n\nChange or turn off alerts on the site's Users page.\n";
  if (OUT) { fs.writeFileSync(path.join(OUT, p.id + ".html"), html); console.log(`Preview for one person: ${hits.length} listing(s); subject: ${subject}`); }
  else {
    const pass = (process.env.GMAIL_APP_PASSWORD || "").replace(/\s+/g, ""); if (!pass) { console.error("GMAIL_APP_PASSWORD secret is missing"); process.exit(1); }
    if (!tx) { const nodemailer = (await import("nodemailer")).default; tx = nodemailer.createTransport({ service: "gmail", auth: { user: mail.from, pass } }); }
    await tx.sendMail({ from: `OBX House Hunt <${mail.from}>`, to: p.email, subject, text, html });
  }
  hits.forEach(l => { mine[l.id] = today; }); emailed++; changed = true;
}
// ---- price drops on each person's saved list ----
// alerts/prices.json remembers the last price seen for every saved listing ({person: {listing: price}}),
// for everyone, so turning the checkbox on later only reports drops from then on.
const pricesDoc = await getJson("alerts/prices.json");
const prices = (pricesDoc && pricesDoc.data) || {};
let pricesChanged = false, dropMails = 0;
const pct = (a, b) => Math.round((a - b) / a * 1000) / 10;
for (const f of await listDir("saves")) {
  const pid = f.slice(0, -5); const sv = await getJson("saves/" + f); const items = (sv && sv.data && sv.data.items) || {};
  const base = prices[pid] || (prices[pid] = {}); const drops = [];
  for (const [id, e] of Object.entries(items)) {
    const l = snap.items[id]; if (!l || !l.price || ["Gone", "Sold"].includes(l.status)) continue;
    const was = base[id] ?? (e.snapshot && e.snapshot.price) ?? l.price;
    if (l.price < was) drops.push(Object.assign({ id, was }, l));
    if (base[id] !== l.price) { base[id] = l.price; pricesChanged = true; }
  }
  for (const id in base) if (!items[id]) { delete base[id]; pricesChanged = true; }
  const p = people.find(x => x.id === pid); const a = (p && p.alerts) || {};
  if (!drops.length || !a.drops || !p.email) continue;
  drops.sort((x, y) => (y.was - y.price) - (x.was - x.price));
  const name = String(p.name || p.id).replace(/ \(shared\)$/, "");
  const subject = `OBX alert: ${drops.length === 1 ? `price drop, ${drops[0].address} (${kmoney(drops[0].was)} → ${kmoney(drops[0].price)})` : `${drops.length} price drops on ${name}'s list`}`;
  const row = l => { const ph = photo(l); return `<tr><td style="padding:0 0 14px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fff;border:1px solid #e3ddd0;border-radius:12px;overflow:hidden">
    ${ph ? `<tr><td><a href="${esc(link(l.id))}"><img src="${esc(ph)}" width="560" alt="" style="display:block;width:100%;max-width:560px;height:auto;border:0"></a></td></tr>` : ""}
    <tr><td style="padding:12px 16px 14px;font-family:Helvetica,Arial,sans-serif;color:#17263a">
      <div style="font-size:22px;font-weight:700">${money(l.price)} <span style="font-size:15px;font-weight:600;color:#7a8390;text-decoration:line-through">${money(l.was)}</span></div>
      <div style="font-size:14px;font-weight:700;color:#1a7f4b;margin-top:2px">Down ${money(l.was - l.price)} (${pct(l.was, l.price)}%)</div>
      <div style="font-size:16px;font-weight:600;margin-top:4px">${esc(l.address)}</div>
      <div style="font-size:13px;color:#5b6675;margin-top:2px">${esc(l.area || l.town || "")} · ${esc(KIND[l.kind] || "")}${facts(l) ? " · " + esc(facts(l)) : ""}${l.status && l.status !== "Active" ? " · " + esc(l.status) : ""}</div>
      <div style="margin-top:10px;font-size:14px"><a href="${esc(link(l.id))}" style="color:#b3157c;font-weight:700;text-decoration:none">Open on the map</a> &nbsp;·&nbsp; <a href="${esc(zillow(l))}" style="color:#17263a;text-decoration:none">All photos on Zillow</a></div>
    </td></tr></table></td></tr>`; };
  const html = `<!doctype html><html><body style="margin:0;background:#f3f0e8"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f0e8"><tr><td align="center" style="padding:20px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px">
<tr><td style="font-family:Helvetica,Arial,sans-serif;color:#17263a;padding:0 0 16px">
  <div style="font-size:13px;letter-spacing:.12em;text-transform:uppercase;color:#b3157c;font-weight:700">OBX House Hunt</div>
  <div style="font-size:26px;font-weight:800;margin-top:2px">Price drop${drops.length === 1 ? "" : "s"} on ${esc(name)}'s list</div>
</td></tr>${drops.map(row).join("")}
<tr><td style="font-family:Helvetica,Arial,sans-serif;font-size:11.5px;color:#7a8390;padding:6px 0 20px">You get this because ${esc(name)}'s price-drop alert is on. Change or turn it off on the site's Users page. Listing photos courtesy of the listing brokers. The map link is private, so please don't forward it.</td></tr>
</table></td></tr></table></body></html>`;
  const text = `Price drops on ${name}'s list\n\n` + drops.map(l => `${money(l.was)} → ${money(l.price)} (down ${money(l.was - l.price)})  ${l.address} (${l.area || l.town})\n  ${link(l.id)}`).join("\n\n") + "\n\nChange or turn off alerts on the site's Users page.\n";
  if (OUT) { fs.writeFileSync(path.join(OUT, pid + "-drops.html"), html); console.log(`Price-drop preview for one person: ${drops.length} listing(s); subject: ${subject}`); }
  else {
    const pass = (process.env.GMAIL_APP_PASSWORD || "").replace(/\s+/g, ""); if (!pass) { console.error("GMAIL_APP_PASSWORD secret is missing"); process.exit(1); }
    if (!tx) { const nodemailer = (await import("nodemailer")).default; tx = nodemailer.createTransport({ service: "gmail", auth: { user: mail.from, pass } }); }
    await tx.sendMail({ from: `OBX House Hunt <${mail.from}>`, to: p.email, subject, text, html });
  }
  dropMails++;
}
if (pricesChanged) await putJson("alerts/prices.json", prices, pricesDoc && pricesDoc.sha, "Record saved-listing prices for price-drop alerts");
console.log(`Sent ${dropMails} price-drop email(s)`);

// forget entries older than 90 days
const cutoff = new Date(Date.now() - 90 * 864e5).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
for (const pid in sent) for (const id in sent[pid]) if (sent[pid][id] < cutoff) { delete sent[pid][id]; changed = true; }
if (changed) await putSent(sent, sentDoc && sentDoc.sha);
console.log(`Sent ${emailed} alert email(s)`);
