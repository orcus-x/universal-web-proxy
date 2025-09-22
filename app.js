const express = require('express');
const cookieParser = require('cookie-parser');
const compression = require('compression');
const cors = require('cors');
require('dotenv').config();

// Load proxy handler
// Load proxy handler with fallback
let ProxyHandler;
try {
  ProxyHandler = require('./lib/ultra-proxy-handler');
} catch (e) {
  // Fallback to basic handler if ultra handler fails
  ProxyHandler = require('./lib/proxy-handler');
}

const app = express();

// Get configuration from environment
const TARGET_URL = process.env.TARGET_URL || 'https://example.com';
const PORT = process.env.PORT || 3000;
const IS_VERCEL = process.env.VERCEL_URL !== undefined;

// Determine proxy host
let PROXY_HOST;
if (IS_VERCEL) {
  PROXY_HOST = process.env.VERCEL_URL;
} else if (process.env.PROXY_HOST) {
  PROXY_HOST = process.env.PROXY_HOST;
} else {
  PROXY_HOST = `localhost:${PORT}`;
}

// Initialize proxy handler
const proxyHandler = new ProxyHandler(TARGET_URL, PROXY_HOST);

// Middleware
app.use(compression());
app.use(cors());
app.use(cookieParser());

// Body parsing middleware with better error handling
app.use(express.json({
  limit: '10mb',
  verify: (req, res, buf, encoding) => {
    // Store raw body for fallback
    req.rawBody = buf.toString(encoding || 'utf8');
  },
  strict: false // Allow parsing of non-object JSON values
}));

app.use(express.urlencoded({
  extended: true,
  limit: '10mb'
}));

app.use(express.raw({
  type: (req) => {
    // Only use raw parser if not JSON or URL encoded
    const contentType = req.headers['content-type'] || '';
    return !contentType.includes('application/json') &&
           !contentType.includes('application/x-www-form-urlencoded');
  },
  limit: '50mb'
}));

// Health check endpoint
app.get('/_health', (req, res) => {
  res.json({
    status: 'ok',
    targetUrl: TARGET_URL,
    proxyHost: PROXY_HOST,
    isVercel: IS_VERCEL
  });
});

// Clear cache endpoint
app.post('/_cache/clear', (req, res) => {
  proxyHandler.clearCache();
  res.json({ message: 'Cache cleared' });
});

// Main proxy handler
app.all('*', async (req, res) => {
  await proxyHandler.handleRequest(req, res);
});

// Error handling middleware
app.use((err, req, res, next) => {
  // Handle JSON parsing errors gracefully
  if (err.type === 'entity.parse.failed') {
    // Use raw body if available
    if (req.rawBody !== undefined) {
      req.body = req.rawBody;
      return next();
    }
    // Return error for invalid JSON
    return res.status(400).json({ error: 'Invalid request body' });
  }

  // Log other errors
  if (process.env.NODE_ENV !== 'production') {
    console.error('Server error:', err);
  }
  res.status(500).send('Internal server error');
});

// Start server (only for local development, not for Vercel)
if (!IS_VERCEL) {
  const server = app.listen(PORT, () => {
    const os = require('os');
    const localUrl = `http://localhost:${PORT}`;

    // Get network IP
    const networkInterfaces = os.networkInterfaces();
    let networkIP = 'localhost';
    for (const interfaceName in networkInterfaces) {
      const interfaces = networkInterfaces[interfaceName];
      for (const iface of interfaces) {
        if (iface.family === 'IPv4' && !iface.internal) {
          networkIP = iface.address;
          break;
        }
      }
      if (networkIP !== 'localhost') break;
    }
    const networkUrl = `http://${networkIP}:${PORT}`;

    // Clear console and show Vite-style logs
    console.clear();
    console.log(`  \x1b[32m➜\x1b[0m  \x1b[1mLocal\x1b[0m:   \x1b[36m${localUrl}/\x1b[0m`);
    console.log(`  \x1b[32m➜\x1b[0m  \x1b[1mNetwork\x1b[0m: \x1b[36m${networkUrl}/\x1b[0m`);

    if (process.env.ENABLE_CACHE === 'true') {
      console.log(`  \x1b[32m➜\x1b[0m  \x1b[1mCache\x1b[0m:   \x1b[32menabled\x1b[0m (TTL: ${process.env.CACHE_TTL}s)`);
    }

    console.log('\n  \x1b[90mpress \x1b[1mh + enter\x1b[0m\x1b[90m to show help\x1b[0m\n');
  });

  // Handle keyboard input for help
  process.stdin.on('data', (data) => {
    const input = data.toString().trim();

    if (input === 'h') {
      console.log('\n  \x1b[1mShortcuts\x1b[0m');
      console.log('  \x1b[90mpress \x1b[0m\x1b[1mr + enter\x1b[0m\x1b[90m to restart the server\x1b[0m');
      console.log('  \x1b[90mpress \x1b[0m\x1b[1mc + enter\x1b[0m\x1b[90m to clear cache\x1b[0m');
      console.log('  \x1b[90mpress \x1b[0m\x1b[1mq + enter\x1b[0m\x1b[90m to quit\x1b[0m\n');
    } else if (input === 'r') {
      console.log('\n  \x1b[33mrestarting server...\x1b[0m\n');
      server.close(() => {
        process.exit(0);
      });
    } else if (input === 'c') {
      proxyHandler.clearCache();
      console.log('\n  \x1b[32m✓\x1b[0m Cache cleared\n');
    } else if (input === 'q') {
      console.log('\n  \x1b[90mbye!\x1b[0m\n');
      process.exit(0);
    }
  });

  // Enable raw mode for stdin if TTY
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
  }
}

// Export for Vercel
module.exports = app;