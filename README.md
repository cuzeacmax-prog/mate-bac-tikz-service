# mate-bac-tikz-service

TikZ compilation service for [mate-bac-md](https://github.com/cuzeacmax-prog/mate-bac-md).

## Stack

- Node.js 20 + Express
- TeX Live (full) via Docker
- Deployed on Railway

## API

### POST /compile

Request:
```json
{ "latex": "\\begin{tikzpicture}\\draw (0,0) -- (1,1);\\end{tikzpicture}" }
```

Response (success):
```json
{ 
  "svg": "<svg>...</svg>",
  "cached": false,
  "compile_time_ms": 1240
}
```

Response (error):
```json
{ "error": "LaTeX error: Undefined control sequence" }
```

### GET /health

Returns service status:
```json
{ "status": "ok", "cache_size": 3, "uptime_sec": 120 }
```

## Deployment

Auto-deploys from `main` branch via Railway GitHub integration.

Environment variables:
- `PORT` — set automatically by Railway
