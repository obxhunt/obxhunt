// Weekly "Top Picks" email: listings that two or more family members have saved.
// Runs in GitHub Actions. Needs secrets FAMILY_CODE and GMAIL_APP_PASSWORD.
// Local test: DATA_DIR=<folder with saves/*.json> OUT=preview.html node tools/top-picks.mjs
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

// ---- read the family's shared data ----
async function loadData() {
  const out = {};
  if (process.env.DATA_DIR) {
    for (const dir of ["saves", "patches", "added", "notes"]) {
      const d = path.join(process.env.DATA_DIR, dir); if (!fs.existsSync(d)) continue;
      for (const f of fs.readdirSync(d)) if (f.endsWith(".json")) out[dir + "/" + f] = JSON.parse(fs.readFileSync(path.join(d, f), "utf8"));
    }
    return out;
  }
  const API = "https://api.github.com/repos/obxhunt/obxhunt-data";
  const H = { Authorization: "Bearer " + token, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  const t = await fetch(API + "/git/trees/main?recursive=1", { headers: H });
  if (t.status === 404 || t.status === 409) return out; // nothing saved yet
  if (!t.ok) throw new Error("Couldn't read family data: HTTP " + t.status);
  const tree = (await t.json()).tree || [];
  for (const e of tree) {
    if (e.type !== "blob" || !/^(saves|patches|added|notes)\/[^/]+\.json$/.test(e.path)) continue;
    const b = await fetch(API + "/git/blobs/" + e.sha, { headers: H }); if (!b.ok) continue;
    try { out[e.path] = JSON.parse(Buffer.from((await b.json()).content, "base64").toString("utf8")); } catch {}
  }
  return out;
}

const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const money = n => n ? "$" + Math.round(n).toLocaleString("en-US") : "—";
const FEED = { 6: "NC_OBAR", 8: "VA_REIN", 9: "NC_CCAR" };
const photo = l => { const m = String(l.mls || ""); return /^\d+$/.test(m) && FEED[m.length] ? `https://images-listings.coldwellbanker.com/${FEED[m.length]}/${m.match(/.{1,2}/g).join("/")}/_P/${m}_P00.jpg` : ""; };
const zillow = l => "https://www.zillow.com/homes/" + encodeURIComponent([l.address, l.town, "NC", l.zip || ""].join(" ").trim().replace(/\s+/g, "-")).replace(/%2C/g, "") + "_rb/";
const facts = l => l.kind === "lot" ? (l.acres ? l.acres + " ac" : "") : [l.beds ? l.beds + " bd" : "", l.baths ? l.baths + " ba" : "", l.sqft ? l.sqft.toLocaleString("en-US") + " sq ft" : "", l.acres ? l.acres + " ac" : ""].filter(Boolean).join(" · ");
const KIND = { house: "House", condo: "Condo / townhome", lot: "Lot" };

const data = await loadData();
const listings = new Map(Object.entries(snap.items));
for (const [p, v] of Object.entries(data)) {
  if (p.startsWith("added/")) listings.set(p.slice(6, -5), v);
  if (p.startsWith("patches/")) { const id = p.slice(8, -5); if (listings.has(id)) listings.set(id, Object.assign({}, listings.get(id), v)); }
}
const savers = new Map();
for (const [p, doc] of Object.entries(data)) {
  if (!p.startsWith("saves/")) continue;
  const name = String(doc.name || p.slice(6, -5)).replace(/ \(shared\)$/, "");
  for (const [id, it] of Object.entries(doc.items || {})) { if (!savers.has(id)) savers.set(id, []); savers.get(id).push({ name, it: it || {} }); }
}
// One-off test sends: TEST_IDS lists the listings to feature, and the email is marked as a test.
const TEST_IDS = (process.env.TEST_IDS || "").split(",").map(x => x.trim()).filter(Boolean);
const weekAgo = new Date(Date.now() - 7 * 864e5).toISOString();
const picks = [...savers].filter(([, a]) => a.length >= 2).map(([id, a]) => {
  const cur = listings.get(id); const snapL = a.find(x => x.it.snapshot)?.it.snapshot || {};
  const x = Object.assign({}, snapL, cur || {});
  const at = a.map(s => String(s.it.savedAt || "")).sort();
  const was = snapL.price && cur && cur.price && cur.price !== snapL.price ? cur.price - snapL.price : 0;
  return { id, a, x, gone: !cur, fresh: (at[1] || "") > weekAgo, chg: was };
}).sort((p, q) => q.a.length - p.a.length || (p.x.price || 0) - (q.x.price || 0));
if (TEST_IDS.length) {
  picks.length = 0;
  for (const id of TEST_IDS) {
    const cur = listings.get(id); if (!cur) { console.error("Test listing not found:", id); process.exit(1); }
    const a = savers.get(id) || [];
    picks.push({ id, a, x: cur, gone: false, fresh: false, chg: 0, test: true });
  }
}

const link = id => SITE + "#" + CODE + (id ? "&l=" + encodeURIComponent(id) : "");
const topLink = SITE + "#" + CODE + "&top";
const today = new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "America/New_York" });
const counts = [...new Set([...savers.values()].flat().map(s => s.name))].map(n => [n, [...savers.values()].filter(a => a.some(s => s.name === n)).length]);

const card = p => {
  const l = p.x, ph = photo(l);
  return `<tr><td style="padding:0 0 18px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e3ddd0;border-radius:12px;overflow:hidden;background:#fff">
    ${ph ? `<tr><td><a href="${esc(link(p.id))}"><img src="${esc(ph)}" width="560" alt="" style="display:block;width:100%;max-width:560px;height:auto;border:0"></a></td></tr>` : ""}
    <tr><td style="padding:12px 16px 14px;font-family:Helvetica,Arial,sans-serif;color:#17263a">
      <div style="font-size:22px;font-weight:700">${money(l.price)}${p.chg ? ` <span style="font-size:13px;color:${p.chg < 0 ? "#1d7a46" : "#b3261e"}">${p.chg < 0 ? "▼" : "▲"} ${money(Math.abs(p.chg))} since saved</span>` : ""}${p.fresh ? ` <span style="font-size:11px;background:#b3157c;color:#fff;border-radius:10px;padding:2px 8px;vertical-align:middle">NEW THIS WEEK</span>` : ""}</div>
      <div style="font-size:16px;font-weight:600;margin-top:2px">${esc(l.address || p.id)}</div>
      <div style="font-size:13px;color:#5b6675;margin-top:2px">${esc(l.area || l.town || "")} · ${esc(KIND[l.kind] || "")}${facts(l) ? " · " + esc(facts(l)) : ""}${l.status && l.status !== "Active" ? " · " + esc(l.status) : ""}${p.gone ? " · no longer in the listings feed" : ""}</div>
      <div style="font-size:14px;margin-top:8px">${p.test && p.a.length < 2 ? `<b>★ Sample pick</b> <span style="color:#5b6675">(chosen for this test${p.a.length ? "; saved by " + esc(p.a.map(s => s.name).join(", ")) : ""})</span>` : `<b>★ Saved by ${p.a.length}:</b> ${esc(p.a.map(s => s.name).join(", "))}`}</div>
      ${p.a.filter(s => s.it.note).map(s => `<div style="font-size:13px;color:#5b6675;margin-top:3px">${esc(s.name)}: “${esc(s.it.note)}”</div>`).join("")}
      <div style="margin-top:10px;font-size:14px"><a href="${esc(link(p.id))}" style="color:#b3157c;font-weight:700;text-decoration:none">Open on the map</a> &nbsp;·&nbsp; <a href="${esc(zillow(l))}" style="color:#17263a;text-decoration:none">All photos on Zillow</a></div>
    </td></tr></table></td></tr>`;
};

const html = `<!doctype html><html><body style="margin:0;background:#f3f0e8">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f0e8"><tr><td align="center" style="padding:20px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px">
${TEST_IDS.length ? `<tr><td style="font-family:Helvetica,Arial,sans-serif;padding:0 0 16px"><div style="background:#fff4cc;border:1px solid #e6c34a;border-radius:10px;padding:12px 14px;font-size:14px;color:#5a4500"><b>This is a test email.</b> Drew is trying out the weekly Top Picks email, so the two listings below are samples he picked, not real overlaps. From now on, this email arrives every Sunday morning with the listings two or more of us have saved, and without this note.</div></td></tr>` : ""}
<tr><td style="font-family:Helvetica,Arial,sans-serif;color:#17263a;padding:0 0 16px">
  <div style="font-size:13px;letter-spacing:.12em;text-transform:uppercase;color:#b3157c;font-weight:700">OBX House Hunt</div>
  <div style="font-size:28px;font-weight:800;margin-top:2px">Top Picks</div>
  <div style="font-size:14px;color:#5b6675;margin-top:4px">${esc(today)} · ${TEST_IDS.length ? `${picks.length} sample listings` : picks.length ? `${picks.length} listing${picks.length === 1 ? "" : "s"} saved by two or more of us` : "no overlaps yet"}</div>
</td></tr>
${picks.length ? picks.map(card).join("") : `<tr><td style="font-family:Helvetica,Arial,sans-serif;font-size:15px;color:#17263a;padding:0 0 18px">Nobody has saved the same listing yet. ${counts.length ? "Saved so far: " + esc(counts.map(([n, c]) => `${n} ${c}`).join(", ")) + "." : ""} Heart the places you like on the map and the shared ones will show up here next week.</td></tr>`}
<tr><td style="font-family:Helvetica,Arial,sans-serif;font-size:14px;padding:4px 0 24px"><a href="${esc(topLink)}" style="display:inline-block;background:#17263a;color:#fff;text-decoration:none;font-weight:700;padding:10px 16px;border-radius:8px">Open Top Picks on the map</a></td></tr>
<tr><td style="font-family:Helvetica,Arial,sans-serif;font-size:11.5px;color:#7a8390;padding-bottom:20px">Listing photos courtesy of the listing brokers. Prices and status as of the latest daily refresh (${esc(String(snap.asOf || "").slice(0, 10))}). Sent weekly to the family; the link above is private, so please don't forward it.</td></tr>
</table></td></tr></table></body></html>`;

const text = (TEST_IDS.length ? "TEST EMAIL: these are sample listings Drew picked to try out the weekly Top Picks email. Future emails won't include this note.\n\n" : "") + `OBX House Hunt: Top Picks, ${today}\n\n` + (picks.length ? picks.map(p => `${money(p.x.price)}  ${p.x.address} (${p.x.area || p.x.town})\n  ${facts(p.x)}\n  Saved by: ${p.a.map(s => s.name).join(", ")}\n  ${link(p.id)}\n`).join("\n") : "No overlaps yet.\n") + `\nOpen Top Picks: ${topLink}\n`;
const subject = (TEST_IDS.length ? "[TEST] OBX Top Picks: sample email" : `OBX Top Picks: ${picks.length ? `${picks.length} shared favorite${picks.length === 1 ? "" : "s"}` : "no overlaps yet"}`) + ` (${today})`;

if (process.env.OUT) { fs.writeFileSync(process.env.OUT, html); console.log("Wrote preview:", picks.length, "picks"); process.exit(0); }
const pass = (process.env.GMAIL_APP_PASSWORD || "").replace(/\s+/g, "");
if (!pass) { console.error("GMAIL_APP_PASSWORD secret is missing"); process.exit(1); }
const nodemailer = (await import("nodemailer")).default;
const tx = nodemailer.createTransport({ service: "gmail", auth: { user: mail.from, pass } });
await tx.sendMail({ from: `OBX House Hunt <${mail.from}>`, to: mail.to.join(", "), subject, text, html });
console.log("Sent Top Picks email:", picks.length, "picks to", mail.to.length, "recipients");
