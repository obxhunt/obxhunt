# OBX House Hunt

A private family house-hunting map for the Outer Banks. The site opens only with the family link. The listing data in this repository is encrypted, and everything private (saves, notes, settings) lives elsewhere.

**Maintainers:** the full guide (how the refresh, emails and health checks work, the secrets, renewing keys and troubleshooting) is in the README of the private **obxhunt/obxhunt-data** repository.

## What's here

| Path | What it is |
|---|---|
| `index.html` | The site |
| `data/listings.enc.js` | Encrypted listings, updated automatically several times a day |
| `data/key.enc.js` | Encrypted keys the site needs after it's unlocked |
| `data/audit.json` | A rotating daily sample (~50 listings, public MLS facts only) used for a daily accuracy check |
| `tools/` | Scripts for the email workflows |
| `.github/workflows/` | Listing alerts, Weekly Top Picks email, Health alert |

## Credits

Listings: Outer Banks MLS via Coldwell Banker; listing photos courtesy of the listing brokers. Maps: Esri (World Imagery, World Street Map, Ocean and Light Gray Canvas basemaps). Map library: Leaflet.
