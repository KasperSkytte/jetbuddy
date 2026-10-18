# Jetbuddy

A self-hosted family budget for phones and computers. Plan each person's
income and expenses month by month, keep every year in one place, and see where
the money goes.

Made for households that have outgrown a budget spreadsheet: no cells and no
formulas. Just say what comes in and goes out, and how often, and Jetbuddy does
the sums and the charts.

<p>
  <img src="docs/phone-overview.png" width="200" alt="Overview on a phone">
  <img src="docs/phone-budget.png" width="200" alt="Budget items in plain words on a phone">
  <img src="docs/phone-month.png" width="200" alt="Typing this month's amounts on a phone">
  <img src="docs/phone-trends-dark.png" width="200" alt="Trends across years, dark mode">
</p>
<img src="docs/desktop-overview.png" alt="The overview on a computer">

## What it does

- **Everyone in the household gets their own budget**, kids too, plus a
  shared one for rent, groceries, the car and so on.
- **One app for all years.** Items carry over from year to year with their
  history, and a new year starts as a copy of the last one with one tap.
- **Budget items in plain words.** "2,500 every month", "1,551 every quarter
  from January", "3,248 in February". Tap a single month to change just that one
  when it differs.
- **Made for the phone.** The Month view lists this month's amounts with a
  number keypad, Enter jumps to the next amount, and you can type `120+45` to
  add up receipts. On a computer the same app simply gets more room.
- **Bank sync** through [Enable Banking](https://enablebanking.com) (free for
  your own accounts). Real account balances month by month, and the bank's
  transactions sorted onto the budget items so you see what was actually paid
  next to what was planned. One tap corrects the budget to the real amount.
- **Account balances.** Follows the budget account and savings month by month,
  from the bank or typed in by hand; the following months continue from the
  last real balance.
- **Statistics:** balance, average monthly income and expenses, how much was
  saved and the savings rate, fixed versus variable expenses, per person, per
  category, the largest expenses, and trends and comparisons across years.
  Every chart can be shown as a table.
- **Excel export for the bank.** When you apply for a loan: a tidy workbook with
  the key figures per month and year, the whole budget by category or person,
  what the bank actually paid against the plan (showing that you keep to it),
  and the account balances month by month.
- **Import** from Excel/CSV/Google Sheets, and back up or restore everything as
  one JSON file.
- Installs as an app on the phone's home screen. Light and dark mode. English
  and Danish, any currency and number format.
- Your data stays on your server: one SQLite file, no accounts, no tracking,
  no external services.

## Run it

With Docker Compose (see [`docker-compose.yml`](docker-compose.yml)):

```yaml
services:
  jetbuddy:
    image: ghcr.io/kasperskytte/jetbuddy:latest
    restart: unless-stopped
    ports:
      - "8000:8000"
    volumes:
      - ./data:/data
```

```bash
docker compose up -d
```

Open `http://<server>:8000` and create your budget: the household, the people
in it, and a username and password that everyone in the household shares. To build the image
yourself instead, run `docker build -t jetbuddy .` in this folder.

### Settings

| Variable | Default | |
|---|---|---|
| `JETBUDDY_ALLOW_NEW_BUDGETS` | `true` | Whether new budgets can be created from the login page. The first budget can always be created. Turn it off if the server is reachable from the internet. |
| `JETBUDDY_BANK_SYNC_HOURS` | `6` | How often to sync connected banks. `0` turns automatic sync off. |
| `JETBUDDY_PUBLIC_URL` | *(from the request)* | The address people use, e.g. `https://jetbuddy.example.home`, if the bank's redirect URL comes out wrong behind your proxy. |
| `JETBUDDY_SECRET` | *(generated)* | Key that signs login cookies. Generated into the data folder if not set. |
| `JETBUDDY_DATA_DIR` | `/data` | Where the data lives. |

### Budgets and logins

Each budget (household) has one login that everyone in it shares, and one
server can hold several budgets, each with its own data, accounts and bank
connection. Phones stay logged in for a year. Change the username or password,
or delete the budget, under **Settings → Login**; a new password logs out all
other devices. After 10 wrong passwords from one address, logging in pauses
for 15 minutes.

### On the phone

Open the address in the phone's browser and choose **Add to Home Screen**
(Safari's share menu on iPhone, the ⋮ menu in Chrome on Android). Jetbuddy then
opens full screen like any other app.

Android only installs a real app (rather than a bookmark) when the site is
served over **HTTPS**. Put Jetbuddy behind the reverse proxy you already use
(Caddy, Traefik, Nginx Proxy Manager, SWAG…), for example
`https://budget.example.home`. It works over plain HTTP too, just without the
offline start-up.

### Backups

Everything is in the `data` folder: `jetbuddy.db` lists the budgets and their
logins, and `budgets/<id>/` holds each budget. Copy the folder (preferably while
the container is stopped), or use **Settings → Download a backup** for a JSON
file of one budget that **Restore a backup** reads back in.

## Bringing in an old spreadsheet

If your budget lives in Excel or Google Sheets today, **Settings → Import from a
spreadsheet** brings it in once, so you can leave the spreadsheet behind. It
reads `.xlsx` and `.csv` files with one row per item and one column per month:

```
          Jan    Feb    Mar  …
Salary    31250  34600  31250
Rent      12450  12900  12300
```

Every tab becomes a list you assign to a person, as income or expenses. Tabs
that are mostly formulas (summaries) are left out, minus signs are handled, and
numbers like `1.234,50` and `1,234.50` both work. From Google Sheets, use
*File → Download → Microsoft Excel*. Import one file per year: items with the
same name are joined, so their history follows them across years.

## How the numbers work

- **Items** are an income or an expense belonging to a person or to the shared
  budget, with an amount for each month. Amounts are always positive; whether
  money comes in or goes out depends on the item.
- **Balance** is income minus expenses.
- An expense that **moves money to a savings account** (pick the account on the
  item) still counts as an expense in the budget, but adds to that account's
  balance and counts as **saved**. The savings rate is what was saved plus
  what was left over, as a share of income.
- The **budget account** changes each month by income minus expenses. Account
  balances need one real balance to start from, typed in the Month view.
- **Fixed** marks items paid by automatic transfer or direct debit, so you can
  see how much of the budget is locked in.

## Bank sync

Banks in the EU and UK must give read access to accounts under PSD2, but only
to licensed providers. Jetbuddy uses [Enable Banking](https://enablebanking.com),
whose free *restricted* mode covers accounts you link yourself, which is
what a household needs. You log in with the bank's own login (MitID in
Denmark); Jetbuddy can only read, never move money.

Setting it up takes about ten minutes, once, and happens entirely in the app:
**Settings → Bank** walks you through Enable Banking's registration form field
by field. In short:

1. Create an account at [enablebanking.com](https://enablebanking.com/sign-in/).
2. In Jetbuddy, make a key: the private key stays on your server, and you get a
   certificate to give Enable Banking.
3. In Enable Banking's Control Panel, add an application: **Production**,
   *Generate outside the browser and import public certificate*, the redirect
   URL Jetbuddy shows (e.g. `https://jetbuddy.example.home/api/bank/callback`;
   it only has to work in your own browser, so a home-network address is
   fine), and the certificate.
4. Choose **Activate by linking accounts** on the application and log in to your
   bank, so the application may read those accounts.
5. Paste the application ID into Jetbuddy. It tests the connection right away;
   then **Connect a bank**.

Then for each bank account choose which Jetbuddy account its balance belongs
to, and whether its transactions should be sorted onto the budget (on for the
budget account, usually off for savings).

- **Balances:** the end-of-month balance of every completed month the
  transactions reach back to is saved as that account's real balance. Balances
  you typed in yourself are kept.
- **Transactions:** in the Month view, sort each transaction onto a budget item,
  ignore it (transfers between your own accounts), or make a new item from it.
  Tick *Do the same with transactions containing…* and later ones sort
  themselves. Items then show what the bank paid next to the plan.
- **Syncing** happens every 6 hours and from the *Sync now* button. Banks allow
  a few automatic fetches a day, and access has to be renewed with a new bank
  login every 90–180 days; Jetbuddy shows when.

The private key is stored only in the data folder on your server, and is not
part of backups.

## Development

```bash
python -m venv .venv
.venv/bin/pip install -r requirements-dev.txt
JETBUDDY_DATA_DIR=./data .venv/bin/uvicorn app.main:app --reload
.venv/bin/pytest
```

To try it with made-up data: start it with an empty data folder and run
`python scripts/seed_demo.py http://localhost:8000`.

- `app/`: FastAPI backend. `calc.py` has all the totals and balances, `banking.py`
  the Enable Banking client and sync, `importer.py` reads spreadsheets, and the
  schema and migrations are in `db.py`. Money is
  stored as whole cents.
- `static/`: the web app, with no build step: [Preact](https://preactjs.com) and
  [htm](https://github.com/developit/htm) are vendored in `static/vendor`, and
  the charts are plain SVG.
- Translations are in `static/js/i18n.js`. To add a language, copy the `en`
  block and translate it.
- The API is documented at `/api/docs` on a running instance.

## License

MIT
