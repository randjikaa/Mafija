# 🔪 MAFIJA — Multiplayer Narator

Svako igra na svom telefonu. Jedan napravi sobu, deli kod, ostali se pridružuju.

## Kako pokrenuti lokalno (za testiranje)

```bash
npm install
npm start
```
Otvori `http://localhost:3000` u browseru.

## Kako deployovati na Railway (besplatno, zauvek online)

### Korak 1 — GitHub
1. Idi na [github.com](https://github.com) → New repository → ime npr. `mafija`
2. Uploaduj sve fajlove iz ovog foldera

### Korak 2 — Railway
1. Idi na [railway.app](https://railway.app)
2. Prijavi se sa GitHub nalogom (besplatno)
3. Klikni **New Project → Deploy from GitHub repo**
4. Izaberi `mafija` repo → **Deploy**
5. Sačekaj 1-2 minuta
6. Klikni na **Settings → Domains → Generate Domain**
7. Dobiješ link tipa `mafija-production.up.railway.app`

Taj link pošalji svim igračima — otvore na telefonu i igraju!

## Kako igrati

1. Jedan igrač napravi sobu → dobije 4-slovni kod
2. Ostali unose isti kod i pridružuju se
3. Host klikne "Pokreni igru"
4. Svako na svom telefonu vidi svoju ulogu
5. Noću svako gleda samo svoj ekran i bira metu
6. Narator (server) automatski vodi igru

## Struktura

```
mafia/
  server.js        ← Node.js WebSocket server
  package.json
  railway.json     ← Railway config
  public/
    index.html     ← Cela igra (klijent)
```
