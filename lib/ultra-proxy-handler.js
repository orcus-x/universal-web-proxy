const { request, Agent } = require('undici');
const got = require('got');
const { HttpProxyAgent, HttpsProxyAgent } = require('hpagent');
const randomUseragent = require('random-useragent');
const { CookieJar } = require('tough-cookie');
const { wrapper } = require('http2-wrapper');
const URLRewriter = require('./url-rewriter');
const HTMLModifier = require('./html-modifier');
const CloudflareBypass = require('./cloudflare-bypass');
const crypto = require('crypto');

class UltraProxyHandler {
  constructor(targetUrl, proxyHost) {
    this.targetUrl = targetUrl;
    this.proxyHost = proxyHost;
    this.urlRewriter = new URLRewriter(targetUrl, proxyHost);
    this.htmlModifier = new HTMLModifier(this.urlRewriter);

    // Session management
    this.sessions = new Map();
    this.cache = new Map();
    this.cacheEnabled = process.env.ENABLE_CACHE === 'true';
    this.cacheTTL = parseInt(process.env.CACHE_TTL || '3600') * 1000;

    // Cookie jars per session
    this.cookieJars = new Map();

    // User agents pool
    this.userAgents = this.generateUserAgents();

    // Initialize HTTP clients
    this.initializeClients();

    // Initialize Cloudflare bypass
    this.cloudflareBypass = new CloudflareBypass();
  }

  initializeClients() {
    // Undici agent with optimized settings
    this.undiciAgent = new Agent({
      connections: 100,
      pipelining: 10,
      keepAliveTimeout: 30000,
      keepAliveMaxTimeout: 60000,
      connect: {
        rejectUnauthorized: false,
        timeout: 30000,
        // Custom TLS settings to mimic browsers
        secureOptions: crypto.constants.SSL_OP_NO_SSLv2 | crypto.constants.SSL_OP_NO_SSLv3,
        ciphers: [
          'TLS_AES_128_GCM_SHA256',
          'TLS_AES_256_GCM_SHA384',
          'TLS_CHACHA20_POLY1305_SHA256',
          'ECDHE-RSA-AES128-GCM-SHA256',
          'ECDHE-RSA-AES256-GCM-SHA384',
          'ECDHE-RSA-AES128-SHA256',
          'ECDHE-RSA-AES256-SHA384'
        ].join(':'),
        honorCipherOrder: true,
        minVersion: 'TLSv1.2',
        maxVersion: 'TLSv1.3'
      }
    });

    // Got instance with HTTP/2 support
    this.gotInstance = got.extend({
      http2: true,
      throwHttpErrors: false,
      followRedirect: false,
      decompress: true,
      timeout: {
        request: 30000
      },
      headers: {
        'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9',
        'cache-control': 'no-cache',
        'pragma': 'no-cache',
        'upgrade-insecure-requests': '1'
      },
      https: {
        rejectUnauthorized: false,
        minVersion: 'TLSv1.2'
      },
      retry: {
        limit: 2,
        methods: ['GET', 'POST'],
        statusCodes: [408, 413, 429, 500, 502, 503, 504]
      }
    });
  }

  generateUserAgents() {
    // Generate realistic user agents
    const browsers = [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2.1 Safari/605.1.15',
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
    ];
    return browsers;
  }

  async handleRequest(req, res) {
    try {
      // Get or create session
      const sessionId = this.getOrCreateSession(req);
      const session = this.sessions.get(sessionId);

      // Build target URL
      const targetPath = req.path;
      const fullTargetUrl = `${this.targetUrl}${targetPath}${req._parsedUrl.search || ''}`;

      // Check cache
      if (this.cacheEnabled && req.method === 'GET') {
        const cached = this.getFromCache(fullTargetUrl);
        if (cached) {
          this.sendResponse(res, cached.data, cached.headers, cached.status);
          return;
        }
      }

      // Try different strategies
      let response = null;
      let lastError = null;

      // Strategy 0: Try HTTP/2 with Chrome fingerprint for Cloudflare sites
      if (this.mightBeCloudflare(fullTargetUrl)) {
        try {
          response = await this.makeHTTP2Request(req, fullTargetUrl, session);

          // Check if it's a Cloudflare challenge
          if (response && this.cloudflareBypass.isCloudflareChallenge(response.data)) {
            const solvedUrl = await this.cloudflareBypass.solveChallenge(response.data, fullTargetUrl);
            if (solvedUrl) {
              response = await this.makeHTTP2Request(req, solvedUrl, session);
            }
          }
        } catch (error) {
          lastError = error;
        }
      }

      // Strategy 1: Try Undici (fastest)
      if (!response) {
        try {
          response = await this.makeUndiciRequest(req, fullTargetUrl, session);
        } catch (error) {
          lastError = error;
        }
      }

      // Strategy 2: Try Got with HTTP/2
      if (!response) {
        try {
          response = await this.makeGotRequest(req, fullTargetUrl, session);
        } catch (error) {
          lastError = error;
        }
      }

      // Strategy 3: Fallback to axios with special headers
      if (!response) {
        try {
          response = await this.makeAxiosRequest(req, fullTargetUrl, session);
        } catch (error) {
          lastError = error;
        }
      }

      if (!response) {
        throw lastError || new Error('All request strategies failed');
      }

      // Handle redirects
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.location || response.headers.Location;
        if (location) {
          // Always rewrite location headers to stay within proxy
          let newLocation;
          if (location.startsWith('http://') || location.startsWith('https://')) {
            // Absolute URL - rewrite to proxy
            newLocation = this.urlRewriter.toProxyUrl(location, fullTargetUrl);
          } else if (location.startsWith('/')) {
            // Relative URL - keep as is
            newLocation = location;
          } else {
            // Relative URL without leading slash
            newLocation = this.urlRewriter.toProxyUrl(location, fullTargetUrl);
          }

          res.redirect(response.status, newLocation);
          return;
        }
      }

      // Process response
      const processedResponse = await this.processResponse(response, fullTargetUrl);

      // Update session cookie
      if (!req.cookies?.sessionId) {
        res.cookie('sessionId', sessionId, {
          httpOnly: true,
          secure: !this.proxyHost.includes('localhost'),
          maxAge: 24 * 60 * 60 * 1000,
          sameSite: 'lax'
        });
      }

      // Cache if applicable
      if (this.cacheEnabled && req.method === 'GET' && response.status === 200) {
        this.addToCache(fullTargetUrl, processedResponse);
      }

      // Send response
      this.sendResponse(res, processedResponse.data, processedResponse.headers, processedResponse.status);

    } catch (error) {
      console.error('Ultra proxy error:', error.message);
      this.sendErrorResponse(res, error);
    }
  }

  async makeUndiciRequest(req, url, session) {
    const headers = this.buildHeaders(req, session);
    const requestBody = this.prepareRequestBody(req.body);

    const { statusCode, headers: responseHeaders, body } = await request(url, {
      method: req.method,
      headers,
      body: requestBody,
      dispatcher: this.undiciAgent
    });

    // Read body
    let data = '';
    for await (const chunk of body) {
      data += chunk;
    }

    return {
      status: statusCode,
      headers: responseHeaders,
      data
    };
  }

  async makeGotRequest(req, url, session) {
    const headers = this.buildHeaders(req, session);
    const requestBody = this.prepareRequestBody(req.body);

    const response = await this.gotInstance(url, {
      method: req.method,
      headers,
      body: requestBody,
      cookieJar: this.getCookieJar(session.id)
    });

    return {
      status: response.statusCode,
      headers: response.headers,
      data: response.body
    };
  }

  async makeHTTP2Request(req, url, session) {
    try {
      const requestBody = this.prepareRequestBody(req.body);

      const response = await this.cloudflareBypass.makeHTTP2Request(url, {
        method: req.method,
        headers: this.buildHeaders(req, session),
        body: requestBody,
        userAgent: session.userAgent
      });

      return {
        status: parseInt(response.status),
        headers: response.headers,
        data: response.body
      };
    } catch (error) {
      throw error;
    }
  }

  mightBeCloudflare(url) {
    // Common Cloudflare-protected domains or patterns
    const cloudflarePatterns = [
      'cloudflare',
      'cf-',
      'upwork.com',
      'fiverr.com',
      'discord.com',
      'medium.com'
    ];

    return cloudflarePatterns.some(pattern => url.toLowerCase().includes(pattern));
  }

  async makeAxiosRequest(req, url, session) {
    const axios = require('axios');
    const headers = this.buildHeaders(req, session);

    const response = await axios({
      method: req.method,
      url,
      headers,
      data: req.body,
      responseType: 'arraybuffer',
      validateStatus: () => true,
      maxRedirects: 0,
      timeout: 30000,
      decompress: true,
      // Advanced axios config
      httpAgent: new (require('http').Agent)({
        keepAlive: true,
        keepAliveMsecs: 30000
      }),
      httpsAgent: new (require('https').Agent)({
        keepAlive: true,
        keepAliveMsecs: 30000,
        rejectUnauthorized: false,
        // TLS fingerprinting bypass
        secureOptions: crypto.constants.SSL_OP_NO_SSLv2 | crypto.constants.SSL_OP_NO_SSLv3,
        ciphers: 'HIGH:!aNULL:!MD5:!3DES',
        honorCipherOrder: true,
        minVersion: 'TLSv1.2'
      })
    });

    return {
      status: response.status,
      headers: response.headers,
      data: response.data.toString('utf-8')
    };
  }

  buildHeaders(req, session) {
    const targetUrl = new URL(this.targetUrl);
    const userAgent = session.userAgent;

    // Build browser-like headers
    const headers = {
      'host': targetUrl.host,
      'user-agent': userAgent,
      'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
      'accept-language': 'en-US,en;q=0.9',
      'accept-encoding': 'gzip, deflate, br',
      'cache-control': 'no-cache',
      'pragma': 'no-cache',
      'dnt': '1',
      'upgrade-insecure-requests': '1',
      'sec-ch-ua': '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'sec-fetch-dest': 'document',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-site': req.headers.referer ? 'same-origin' : 'none',
      'sec-fetch-user': '?1'
    };

    // Add referer if exists
    if (req.headers.referer) {
      headers['referer'] = this.urlRewriter.toTargetUrl(req.headers.referer);
    }

    // Add origin for POST requests
    if (req.method === 'POST') {
      headers['origin'] = targetUrl.origin;
      headers['content-type'] = req.headers['content-type'] || 'application/x-www-form-urlencoded';
    }

    // Add cookies if available
    if (session.cookies && session.cookies.length > 0) {
      headers['cookie'] = session.cookies;
    }

    return headers;
  }

  getOrCreateSession(req) {
    let sessionId = req.cookies?.sessionId;

    if (!sessionId || !this.sessions.has(sessionId)) {
      sessionId = this.generateSessionId();
      const userAgent = this.userAgents[Math.floor(Math.random() * this.userAgents.length)];

      this.sessions.set(sessionId, {
        id: sessionId,
        userAgent,
        cookies: '',
        created: Date.now()
      });
    }

    return sessionId;
  }

  getCookieJar(sessionId) {
    if (!this.cookieJars.has(sessionId)) {
      this.cookieJars.set(sessionId, new CookieJar());
    }
    return this.cookieJars.get(sessionId);
  }

  async processResponse(response, pageUrl) {
    const contentType = response.headers['content-type'] || '';
    let data = response.data;

    // Process text content
    if (this.isTextContent(contentType)) {
      // Process HTML
      if (contentType.includes('text/html')) {
        data = this.htmlModifier.modifyHtml(data, pageUrl);

        // Inject advanced anti-detection scripts
        data = this.injectUltraScripts(data);
      }
      // Process CSS
      else if (contentType.includes('text/css')) {
        data = this.urlRewriter.rewriteCss(data, pageUrl);
      }
      // Process JavaScript
      else if (contentType.includes('javascript')) {
        data = this.urlRewriter.rewriteJavaScript(data, pageUrl);
      }
    }

    // Process headers
    const headers = this.processResponseHeaders(response.headers);

    return {
      data,
      headers,
      status: response.status
    };
  }

  processResponseHeaders(headers) {
    const processed = { ...headers };

    // Remove problematic headers
    const headersToRemove = [
      'content-encoding',
      'content-length',
      'transfer-encoding',
      'connection',
      'strict-transport-security',
      'content-security-policy',
      'content-security-policy-report-only',
      'x-frame-options',
      'x-content-type-options',
      'x-xss-protection',
      'report-to',
      'nel',
      'expect-ct',
      'permissions-policy',
      'cross-origin-embedder-policy',
      'cross-origin-opener-policy',
      'cross-origin-resource-policy'
    ];

    headersToRemove.forEach(header => {
      delete processed[header];
      delete processed[header.toLowerCase()];
    });

    // Add permissive CORS
    processed['access-control-allow-origin'] = '*';
    processed['access-control-allow-methods'] = '*';
    processed['access-control-allow-headers'] = '*';
    processed['access-control-allow-credentials'] = 'true';

    // Handle cookies
    if (processed['set-cookie']) {
      processed['set-cookie'] = this.processSetCookieHeaders(processed['set-cookie']);
    }

    return processed;
  }

  processSetCookieHeaders(setCookieHeaders) {
    if (!Array.isArray(setCookieHeaders)) {
      setCookieHeaders = [setCookieHeaders];
    }

    return setCookieHeaders.map(cookie => {
      const parts = cookie.split(';').map(p => p.trim());
      const modified = [];

      parts.forEach(part => {
        const lower = part.toLowerCase();

        // Skip domain
        if (lower.startsWith('domain=')) return;

        // Handle secure
        if (lower === 'secure' && this.proxyHost.includes('localhost')) return;

        // Modify SameSite
        if (lower.startsWith('samesite=')) {
          modified.push('SameSite=Lax');
          return;
        }

        modified.push(part);
      });

      return modified.join('; ');
    });
  }

  injectUltraScripts(html) {
    const ultraScript = `
      <script>
        // Ultra anti-detection
        (function() {
          // Override detection properties
          const overrides = {
            navigator: {
              webdriver: false,
              plugins: [1,2,3,4,5],
              languages: ['en-US', 'en'],
              platform: 'Win32',
              hardwareConcurrency: 8,
              deviceMemory: 8,
              maxTouchPoints: 0
            },
            screen: {
              width: 1920,
              height: 1080,
              availWidth: 1920,
              availHeight: 1040,
              colorDepth: 24,
              pixelDepth: 24
            }
          };

          // Apply overrides
          for (const [obj, props] of Object.entries(overrides)) {
            for (const [prop, value] of Object.entries(props)) {
              try {
                Object.defineProperty(window[obj], prop, {
                  get: () => value,
                  configurable: true
                });
              } catch (e) {}
            }
          }

          // Chrome object
          if (!window.chrome) {
            window.chrome = {
              runtime: {},
              loadTimes: function() {},
              csi: function() {},
              app: {}
            };
          }

          // WebGL vendor
          const getParameter = WebGLRenderingContext.prototype.getParameter;
          WebGLRenderingContext.prototype.getParameter = function(parameter) {
            if (parameter === 37445) return 'Intel Inc.';
            if (parameter === 37446) return 'Intel Iris OpenGL Engine';
            return getParameter.apply(this, arguments);
          };

          // Permissions
          const originalQuery = window.navigator.permissions?.query;
          if (originalQuery) {
            window.navigator.permissions.query = (parameters) => (
              parameters.name === 'notifications' ?
                Promise.resolve({ state: Notification.permission }) :
                originalQuery(parameters)
            );
          }

          // Console detection
          let devtools = {open: false, orientation: null};
          setInterval(() => {
            if (window.outerHeight - window.innerHeight > 200 ||
                window.outerWidth - window.innerWidth > 200) {
              devtools.open = true;
            } else {
              devtools.open = false;
            }
          }, 500);
        })();
      </script>
    `;

    // Insert before closing head
    if (html.includes('</head>')) {
      return html.replace('</head>', ultraScript + '</head>');
    } else {
      return ultraScript + html;
    }
  }

  sendResponse(res, data, headers, status) {
    Object.entries(headers).forEach(([key, value]) => {
      if (value !== undefined) {
        res.set(key, value);
      }
    });

    res.status(status);
    res.send(data);
  }

  sendErrorResponse(res, error) {
    const status = error.response?.status || 500;
    const message = error.message || 'Unknown error';

    res.status(status).send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Proxy Error</title>
        <style>
          body {
            font-family: -apple-system, system-ui, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            margin: 0;
          }
          .error-container {
            background: white;
            border-radius: 20px;
            padding: 40px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            max-width: 600px;
            text-align: center;
          }
          h1 { color: #333; }
          .status-code {
            font-size: 120px;
            font-weight: bold;
            background: linear-gradient(135deg, #667eea, #764ba2);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            margin: 20px 0;
          }
          .message {
            color: #666;
            margin: 20px 0;
            padding: 20px;
            background: #f5f5f5;
            border-radius: 10px;
          }
          .suggestions {
            text-align: left;
            margin-top: 30px;
            padding: 20px;
            background: #e8f4fd;
            border-radius: 10px;
          }
          .suggestions li {
            margin: 10px 0;
            color: #555;
          }
          .retry-btn {
            background: linear-gradient(135deg, #667eea, #764ba2);
            color: white;
            border: none;
            padding: 15px 40px;
            border-radius: 30px;
            font-size: 16px;
            font-weight: bold;
            cursor: pointer;
            margin-top: 30px;
            transition: transform 0.2s;
          }
          .retry-btn:hover {
            transform: scale(1.05);
          }
        </style>
      </head>
      <body>
        <div class="error-container">
          <div class="status-code">${status}</div>
          <h1>Unable to Load Page</h1>
          <div class="message">
            <strong>Error:</strong> ${message}
          </div>
          <div class="suggestions">
            <strong>Possible solutions:</strong>
            <ul>
              <li>The website may be using advanced protection</li>
              <li>Try refreshing the page in a few seconds</li>
              <li>Check if the target URL is accessible</li>
              <li>Some sites may require browser mode: <code>npm run browser</code></li>
            </ul>
          </div>
          <button class="retry-btn" onclick="location.reload()">
            Try Again
          </button>
        </div>
      </body>
      </html>
    `);
  }

  isTextContent(contentType) {
    const textTypes = [
      'text/',
      'application/javascript',
      'application/json',
      'application/xml',
      'application/xhtml+xml'
    ];

    return textTypes.some(type => contentType.includes(type));
  }

  generateSessionId() {
    return crypto.randomBytes(16).toString('hex');
  }

  getFromCache(url) {
    if (!this.cacheEnabled) return null;

    const cached = this.cache.get(url);
    if (!cached) return null;

    const now = Date.now();
    if (now - cached.timestamp > this.cacheTTL) {
      this.cache.delete(url);
      return null;
    }

    return cached;
  }

  addToCache(url, response) {
    if (!this.cacheEnabled) return;

    if (this.cache.size > 500) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }

    this.cache.set(url, {
      ...response,
      timestamp: Date.now()
    });
  }

  prepareRequestBody(body) {
    if (!body) return undefined;

    if (typeof body === 'string') {
      return body;
    } else if (Buffer.isBuffer(body)) {
      return body;
    } else {
      return JSON.stringify(body);
    }
  }

  clearCache() {
    this.cache.clear();
  }

  // Clean up old sessions periodically
  cleanupSessions() {
    const now = Date.now();
    const maxAge = 24 * 60 * 60 * 1000; // 24 hours

    for (const [id, session] of this.sessions) {
      if (now - session.created > maxAge) {
        this.sessions.delete(id);
        this.cookieJars.delete(id);
      }
    }
  }
}

module.exports = UltraProxyHandler;