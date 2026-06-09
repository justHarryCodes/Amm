# Peg Maintainer + Bulk Sender — Setup Guide

## Project Structure

```
liquidity2/
├── backend/          Node.js + Express + ethers.js API
├── frontend/         Next.js 14 + Tailwind UI
├── contracts/        Solidity MultiSender contract (Hardhat)
└── database/         PostgreSQL schema
```

---

## Prerequisites

- Node.js 18+
- PostgreSQL 14+ (or a Supabase project)
- A BSC bot wallet with BNB for gas
- PancakeSwap V2 pair already deployed for your token/USDC or token/USDT

---

## Step 1 — MultiSender contract

**Already deployed on BNB Mainnet** — no deployment needed.

| Network | Address |
|---|---|
| BNB Mainnet | `0xfc13372d4747Bbf846a8ADd351aF32E0Be956836` |

This address is pre-configured in `MULTISENDER_ADDRESS` in `backend/.env.example` and auto-fills in the frontend. You only need the `contracts/` folder if you want to deploy to testnet or verify the source.

---

## Step 2 — Configure the backend

```bash
cd backend
npm install
cp .env.example .env
```

Edit `backend/.env`:

| Variable | Description |
|---|---|
| `NETWORK` | `testnet` or `mainnet` |
| `BOT_PRIVATE_KEY` | Your bot wallet private key — **never commit this** |
| `TOKEN_ADDRESS` | Your BEP20 token address |
| `USDC_ADDRESS` / `USDT_ADDRESS` | Stablecoin address used in the pair |
| `PAIR_ADDRESS` | PancakeSwap V2 pair contract address |
| `TARGET_PEG` | Target price in USD, e.g. `1.0` |
| `UPPER_BAND` | Upper deviation before selling, e.g. `0.02` = 2% |
| `LOWER_BAND` | Lower deviation before buying, e.g. `0.02` = 2% |
| `MAX_TRADE_SIZE_TOKENS` | Max tokens per trade |
| `MAX_DAILY_SPEND_USD` | Max USD the bot can spend buying per day |
| `MIN_LIQUIDITY_USD` | Minimum pool liquidity required before trading |
| `COOLDOWN_SECONDS` | Seconds to wait between trades (default 300) |
| `DATABASE_URL` | PostgreSQL connection string |
| `API_SECRET` | Secret key for frontend → backend auth |

### Run DB migration

```bash
npm run migrate
```

### Start the backend

```bash
npm run dev          # development (ts-node-dev, hot reload)
npm run build && npm start  # production
```

The server starts on `http://localhost:3001`.

---

## Step 3 — Configure the frontend

```bash
cd frontend
npm install
cp .env.local.example .env.local
```

Edit `frontend/.env.local`:

```
NEXT_PUBLIC_API_URL=http://localhost:3001
NEXT_PUBLIC_WS_URL=ws://localhost:3001/ws
NEXT_PUBLIC_API_KEY=<same value as API_SECRET in backend .env>
```

### Start the frontend

```bash
npm run dev    # http://localhost:3000
```

---

## Step 4 — First run checklist

1. Open `http://localhost:3000`
2. Dashboard should show "Live" indicator (green dot) in the navbar.
3. Go to **Peg Maintainer** and click **Monitor Only** first.
4. Confirm prices are being read from the chain (check the Live Price card).
5. Review trade log — no trades should execute in monitor-only mode.
6. Once satisfied, switch to **Auto Trade**.

---

## Safety checklist before Auto Trade

- [ ] Tested fully on BSC Testnet
- [ ] `MAX_TRADE_SIZE_TOKENS` is set conservatively (start small!)
- [ ] `MAX_DAILY_SPEND_USD` is set to an amount you can afford to lose
- [ ] `MIN_LIQUIDITY_USD` is set to prevent trading thin pools
- [ ] `COOLDOWN_SECONDS` ≥ 60 to avoid rapid-fire trades
- [ ] `SLIPPAGE_TOLERANCE` ≤ 1% for a liquid pair
- [ ] Bot wallet has enough BNB for gas (0.5+ BNB recommended)
- [ ] Emergency Pause button tested (just click it and check state changes)
- [ ] Backend is running on a always-on server (Railway / Render / VPS)

---

## Deployment (production)

### Backend — Railway / Render

1. Push `backend/` to a Git repo
2. Set all environment variables in the Railway/Render dashboard
3. Build command: `npm run build`
4. Start command: `npm start`

### Frontend — Vercel

1. Push `frontend/` to a Git repo (or use the monorepo with `Root Directory = frontend`)
2. Set `NEXT_PUBLIC_API_URL` and `NEXT_PUBLIC_WS_URL` to your backend URL
3. Set `NEXT_PUBLIC_API_KEY` to the same value as `API_SECRET`

---

## API Reference

All routes require `x-api-key` header = `API_SECRET`.

### Peg Maintainer

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/peg/status` | Current price, state, daily stats |
| GET | `/api/peg/config` | Current safety settings |
| PUT | `/api/peg/config` | Update settings |
| POST | `/api/peg/start` | `{ mode: "MONITOR_ONLY" \| "AUTO_TRADE" }` |
| POST | `/api/peg/stop` | Stop bot |
| POST | `/api/peg/pause` | Emergency pause |
| POST | `/api/peg/resume` | Resume from pause |
| GET | `/api/peg/trades` | Trade history `?limit=50&offset=0` |
| GET | `/api/peg/prices` | Price history `?hours=24` |
| GET | `/api/peg/balance` | Bot wallet balances |

### Bulk Sender

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/bulk/upload` | Upload CSV — returns preview (no chain calls) |
| POST | `/api/bulk/send` | Upload CSV + send (starts async job) |
| GET | `/api/bulk/jobs` | List all jobs |
| GET | `/api/bulk/jobs/:id` | Job status + batch details |
| GET | `/api/bulk/jobs/:id/export` | Download results as CSV |

### WebSocket (`ws://host/ws`)

| Event | Payload |
|-------|---------|
| `PRICE_UPDATE` | `{ price, tokenReserve, stableReserve, liquidityUsd, timestamp }` |
| `BOT_STATE` | `{ state, settings }` |
| `TRADE` | Trade record |
| `BULK_JOB_START` | `{ jobId }` |
| `BULK_JOB_COMPLETE` | `{ jobId, status }` |
| `BULK_BATCH_CONFIRMED` | `{ jobId, batchNumber, txHash }` |

---

## CSV format for Bulk Sender

```csv
address,amount
0xAbCd...1234,100
0xEfGh...5678,250.5
```

- `address` — checksummed or lowercase ERC-20/BEP-20 address
- `amount` — token amount in human-readable units (not wei)
- Duplicates are automatically removed
- Invalid addresses are skipped with a reason logged

---

## PancakeSwap V2 addresses

| Network | Router | Factory |
|---|---|---|
| BSC Mainnet | `0x10ED43C718714eb63d5aA57B78B54704E256024E` | `0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73` |
| BSC Testnet | `0x9Ac64Cc6e4415144C455BD8E4837Fea55603e5c3` | `0x6725F303b657a9451d8BA641348b6761A6CC7a17` |
