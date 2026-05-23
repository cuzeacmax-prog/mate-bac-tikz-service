const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const execAsync = promisify(exec);
const app = express();
const PORT = process.env.PORT || 3000;

// CORS - permite doar Vercel + localhost
const ALLOWED_ORIGINS = [
  'https://mate-bac-md.vercel.app',
  'http://localhost:3000',
  // Production preview deployments
  /^https:\/\/mate-bac-md-.*\.vercel\.app$/,
];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true); // server-to-server
    const allowed = ALLOWED_ORIGINS.some(o =>
      typeof o === 'string' ? o === origin : o.test(origin)
    );
    callback(allowed ? null : new Error('CORS not allowed'), allowed);
  }
}));

app.use(express.json({ limit: '500kb' }));

// Rate limit: 60 requests per minute per IP
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { error: 'Too many requests, please slow down' }
});
app.use('/compile', limiter);

// In-memory cache (LRU-like, max 100 entries)
const cache = new Map();
const CACHE_MAX = 100;

function getCacheKey(latex) {
  return crypto.createHash('sha256').update(latex).digest('hex');
}

function setCacheValue(key, value) {
  if (cache.size >= CACHE_MAX) {
    const firstKey = cache.keys().next().value;
    cache.delete(firstKey);
  }
  cache.set(key, value);
}

// SANITIZARE INPUT — interzice comenzi periculoase
function sanitizeLatex(latex) {
  const dangerous = [
    /\\write18/i,
    /\\immediate\s*\\write/i,
    /\\openout/i,
    /\\input\s*\{/i,
    /\\include\s*\{/i,
    /\\read/i,
    /\\catcode/i,
    /\\directlua/i,
    /\\openin/i,
  ];
  for (const pattern of dangerous) {
    if (pattern.test(latex)) {
      throw new Error(`Dangerous LaTeX command detected: ${pattern.source}`);
    }
  }
  return latex;
}

// Construim un document LaTeX complet
function buildDocument(tikzCode) {
  return `\\documentclass[border=10mm]{standalone}
\\usepackage{tikz}
\\usepackage{amsmath}
\\usepackage{amssymb}
\\usepackage{xcolor}
\\usetikzlibrary{calc,intersections,arrows.meta,decorations.markings,3d,positioning}
\\begin{document}
${tikzCode}
\\end{document}`;
}

// Endpoint principal
app.post('/compile', async (req, res) => {
  const { latex } = req.body;

  if (!latex || typeof latex !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid latex field' });
  }

  if (latex.length > 50000) {
    return res.status(400).json({ error: 'LaTeX too long (max 50000 chars)' });
  }

  // Cache check
  const cacheKey = getCacheKey(latex);
  if (cache.has(cacheKey)) {
    return res.json({
      svg: cache.get(cacheKey),
      cached: true,
      compile_time_ms: 0
    });
  }

  const startTime = Date.now();
  let tmpDir;

  try {
    sanitizeLatex(latex);

    // Detect if input is full document or just tikzpicture
    const isFullDoc = latex.includes('\\documentclass');
    const fullLatex = isFullDoc ? latex : buildDocument(latex);

    // Create temp dir
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tikz-'));
    const texFile = path.join(tmpDir, 'fig.tex');
    const dviFile = path.join(tmpDir, 'fig.dvi');
    const svgFile = path.join(tmpDir, 'fig.svg');

    await fs.writeFile(texFile, fullLatex, 'utf8');

    // Run latex (produces DVI)
    await execAsync(
      `latex -interaction=nonstopmode -halt-on-error -output-directory=${tmpDir} ${texFile}`,
      { timeout: 30000, maxBuffer: 5 * 1024 * 1024 }
    );

    // Check DVI created
    try {
      await fs.access(dviFile);
    } catch {
      throw new Error('DVI file was not created (LaTeX compilation failed silently)');
    }

    // Convert DVI to SVG with dvisvgm
    await execAsync(
      `dvisvgm --no-fonts --exact-bbox --output=${svgFile} ${dviFile}`,
      { timeout: 15000, maxBuffer: 5 * 1024 * 1024 }
    );

    const svg = await fs.readFile(svgFile, 'utf8');
    setCacheValue(cacheKey, svg);

    const compileTime = Date.now() - startTime;
    res.json({
      svg,
      cached: false,
      compile_time_ms: compileTime
    });

  } catch (error) {
    console.error('[Compile Error]', error.message);

    let userError = 'Compilation failed';
    if (error.message.includes('Dangerous')) {
      userError = error.message;
    } else if (error.stdout) {
      // Extract LaTeX error from output
      const match = error.stdout.match(/! (.+?)\n/);
      if (match) userError = `LaTeX error: ${match[1]}`;
    } else if (error.message.includes('timeout')) {
      userError = 'Compilation timeout (>30s)';
    }

    res.status(400).json({
      error: userError,
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });

  } finally {
    // Cleanup temp dir
    if (tmpDir) {
      fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    cache_size: cache.size,
    uptime_sec: Math.floor(process.uptime())
  });
});

// Root info
app.get('/', (req, res) => {
  res.json({
    service: 'mate-bac-tikz-service',
    version: '1.0.0',
    endpoints: {
      'POST /compile': 'Compile TikZ to SVG',
      'GET /health': 'Service health check'
    }
  });
});

app.listen(PORT, () => {
  console.log(`[Server] Listening on port ${PORT}`);
});
