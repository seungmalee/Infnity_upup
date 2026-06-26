# Deployment Guide

This project runs as a single Node server for No End Rise. The server serves `outputs/index.html` and synchronizes online players, chat, rankings, attacks, and connection events.

## Local Run

```powershell
npm start
```

Open the game in your browser:

```text
http://localhost:3000
```

## Render Deployment

1. Push this folder to a GitHub repository.
2. In Render, choose `New` -> `Web Service`.
3. Connect the GitHub repository.
4. Use these settings:

```text
Build Command: npm install
Start Command: npm start
```

5. After deployment, Render will provide a URL such as `https://...onrender.com`.
6. Add `noendrise.com` as a custom domain in Render, then point the domain DNS records to Render's provided target.

## Railway Deployment

1. Create a new project in Railway.
2. Connect the GitHub repository.
3. If Railway asks for a start command, use:

```text
npm start
```

## Server Notes

- Players connected to the same server URL play on the same map.
- Chat, ranking, floor, kills, lives, and game state are synchronized.
- If the server restarts, live player and chat state may reset.
- For long-term operation, connect a persistent database or cache such as MongoDB, Redis, or another managed storage service.
