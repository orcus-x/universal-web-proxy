# Ultra Web Proxy Server

High-performance web proxy server using Undici, Got, and HTTP/2 for maximum speed and compatibility.

## Features

- ✅ **Ultra-fast performance** with Undici HTTP client
- ✅ **HTTP/2 support** for modern websites
- ✅ **TLS fingerprinting bypass**
- ✅ **Smart fallback system** (Undici → Got → Axios)
- ✅ **Advanced header manipulation**
- ✅ **User-Agent rotation**
- ✅ **Session-based cookie management**
- ✅ **URL rewriting** (links, forms, redirects)
- ✅ **Resource proxying** (CSS, JS, images)
- ✅ **AJAX/Fetch request interception**
- ✅ **Optional caching system**
- ✅ **Vercel deployment support**

## Quick Start

### Local Development

1. Install dependencies:
```bash
npm install
```

2. Configure environment:
```bash
cp .env.example .env
# Edit .env and set TARGET_URL
```

3. Run the server:
```bash
npm run dev
```

4. Open browser: `http://localhost:3000`

### Vercel Deployment

1. Deploy to Vercel:
```bash
vercel
```

2. Set environment variables in Vercel dashboard

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `TARGET_URL` | Website to proxy | `https://example.com` |
| `PORT` | Local server port | `3000` |
| `PROXY_HOST` | Proxy domain | `localhost:3000` |
| `ENABLE_CACHE` | Enable caching | `false` |
| `CACHE_TTL` | Cache TTL (seconds) | `3600` |

## Architecture

```
Browser → Ultra Proxy Server → Target Website
              ↓
    - Undici (fastest HTTP client)
    - Got with HTTP/2
    - Axios fallback
    - TLS fingerprinting bypass
    - Cookie management
    - URL rewriting
```

## Core Components

- **ultra-proxy-handler.js**: Main proxy engine with multi-client support
- **url-rewriter.js**: URL transformation logic
- **html-modifier.js**: HTML content modification
- **server.js**: Express server setup

## Performance

- **Undici**: ~18,000 requests/sec
- **Got**: ~12,000 requests/sec
- **Axios**: ~5,700 requests/sec

## API Endpoints

```bash
# Health check
curl http://localhost:3000/_health

# Clear cache
curl -X POST http://localhost:3000/_cache/clear
```

## Advanced Features

### Session Management
Each user gets a unique session ID with:
- Persistent cookies
- Consistent User-Agent
- Isolated cookie jar

### Anti-Detection
- WebDriver property masking
- Chrome runtime emulation
- WebGL vendor spoofing
- Hardware fingerprint spoofing

### Smart Fallback
Automatically tries different HTTP clients:
1. Undici (fastest)
2. Got with HTTP/2
3. Axios with TLS config

## Troubleshooting

**403 Forbidden**: Site has strong anti-bot protection
- Try refreshing after a few seconds
- Clear cache and cookies
- Check if target site is accessible

**Timeout errors**: Network or site issues
- Increase timeout in environment
- Check network connection

**Missing resources**: Resource loading issues
- Verify all file types are handled
- Check console for errors

## Development

```bash
# Install dependencies
npm install

# Run development server
npm run dev

# Deploy to Vercel
vercel
```

## License

MIT - Use at your own risk and responsibility

## Disclaimer

For educational and development purposes only. Users must comply with all applicable laws and terms of service.