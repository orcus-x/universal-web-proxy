const axios = require('axios');
const URLRewriter = require('./url-rewriter');
const HTMLModifier = require('./html-modifier');

class ProxyHandler {
  constructor(targetUrl, proxyHost) {
    this.targetUrl = targetUrl;
    this.proxyHost = proxyHost;
    this.urlRewriter = new URLRewriter(targetUrl, proxyHost);
    this.htmlModifier = new HTMLModifier(this.urlRewriter);
    this.cache = new Map();
    this.cacheEnabled = process.env.ENABLE_CACHE === 'true';
    this.cacheTTL = parseInt(process.env.CACHE_TTL || '3600') * 1000;
  }

  async handleRequest(req, res) {
    try {
      // Convert proxy path to target URL
      const targetPath = req.path;
      const targetUrl = this.urlRewriter.toTargetUrl(req.url);
      const fullTargetUrl = `${this.targetUrl}${targetPath}${req._parsedUrl.search || ''}`;

      // Check cache for GET requests
      if (this.cacheEnabled && req.method === 'GET') {
        const cached = this.getFromCache(fullTargetUrl);
        if (cached) {
          this.sendResponse(res, cached.data, cached.headers, cached.status);
          return;
        }
      }

      // Prepare request config
      const config = {
        method: req.method,
        url: fullTargetUrl,
        headers: this.prepareRequestHeaders(req),
        data: req.body,
        responseType: 'arraybuffer',
        validateStatus: () => true,
        maxRedirects: 0,
        timeout: 30000,
        decompress: true
      };

      // Handle cookies
      if (req.cookies) {
        const cookieString = this.prepareCookies(req.cookies);
        if (cookieString) {
          config.headers.cookie = cookieString;
        }
      }

      // Make the request
      const response = await axios(config);

      // Handle redirects
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.location;
        if (location) {
          const newLocation = this.urlRewriter.toProxyUrl(location, fullTargetUrl);
          res.redirect(response.status, newLocation);
          return;
        }
      }

      // Process response
      const processedResponse = await this.processResponse(response, fullTargetUrl);

      // Cache if applicable
      if (this.cacheEnabled && req.method === 'GET' && response.status === 200) {
        this.addToCache(fullTargetUrl, processedResponse);
      }

      // Send response
      this.sendResponse(res, processedResponse.data, processedResponse.headers, processedResponse.status);

    } catch (error) {
      console.error('Proxy error:', error.message);
      res.status(500).send('Proxy error: ' + error.message);
    }
  }

  prepareRequestHeaders(req) {
    const headers = { ...req.headers };

    // Remove proxy-specific headers
    delete headers.host;
    delete headers['x-forwarded-for'];
    delete headers['x-forwarded-proto'];
    delete headers['x-forwarded-host'];

    // Set correct host header
    const targetUrl = new URL(this.targetUrl);
    headers.host = targetUrl.host;

    // Update referer if present
    if (headers.referer) {
      headers.referer = this.urlRewriter.toTargetUrl(headers.referer);
    }

    // Update origin if present
    if (headers.origin) {
      headers.origin = targetUrl.origin;
    }

    // Handle accept-encoding
    headers['accept-encoding'] = 'gzip, deflate, br';

    return headers;
  }

  prepareCookies(cookies) {
    // Convert cookie object to string
    return Object.entries(cookies)
      .map(([key, value]) => `${key}=${value}`)
      .join('; ');
  }

  async processResponse(response, pageUrl) {
    const contentType = response.headers['content-type'] || '';
    let data = response.data;

    // Convert buffer to string for text-based content
    if (this.isTextContent(contentType)) {
      const encoding = this.getEncoding(response.headers);
      data = data.toString(encoding);

      // Process HTML content
      if (contentType.includes('text/html')) {
        data = this.htmlModifier.modifyHtml(data, pageUrl);
      }
      // Process CSS content
      else if (contentType.includes('text/css') || contentType.includes('stylesheet')) {
        data = this.urlRewriter.rewriteCss(data, pageUrl);
      }
      // Process JavaScript content
      else if (contentType.includes('javascript') || contentType.includes('application/json')) {
        if (!contentType.includes('application/json')) {
          data = this.urlRewriter.rewriteJavaScript(data, pageUrl);
        }
      }
    }

    // Process response headers
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
    delete processed['content-encoding'];
    delete processed['content-length'];
    delete processed['transfer-encoding'];
    delete processed['connection'];

    // Modify set-cookie headers
    if (processed['set-cookie']) {
      processed['set-cookie'] = this.processSetCookieHeaders(processed['set-cookie']);
    }

    // Update location header for redirects
    if (processed.location) {
      processed.location = this.urlRewriter.toProxyUrl(processed.location);
    }

    // Modify or remove CSP headers
    if (processed['content-security-policy']) {
      // For simplicity, we'll remove CSP. In production, you'd want to modify it appropriately
      delete processed['content-security-policy'];
      delete processed['content-security-policy-report-only'];
    }

    // Remove CORS headers (proxy will handle CORS)
    delete processed['access-control-allow-origin'];
    delete processed['access-control-allow-credentials'];

    // Add CORS headers for proxy
    processed['access-control-allow-origin'] = '*';
    processed['access-control-allow-methods'] = 'GET, POST, PUT, DELETE, OPTIONS';
    processed['access-control-allow-headers'] = 'Content-Type, Authorization';

    // Remove X-Frame-Options to allow embedding
    delete processed['x-frame-options'];

    return processed;
  }

  processSetCookieHeaders(setCookieHeaders) {
    if (!Array.isArray(setCookieHeaders)) {
      setCookieHeaders = [setCookieHeaders];
    }

    return setCookieHeaders.map(cookie => {
      // Parse and modify cookie attributes
      const parts = cookie.split(';').map(part => part.trim());
      const modifiedParts = [];

      parts.forEach(part => {
        if (part.toLowerCase().startsWith('domain=')) {
          // Skip domain attribute to use proxy domain
          return;
        }
        if (part.toLowerCase().startsWith('secure')) {
          // Keep secure only if proxy is HTTPS
          if (!this.proxyHost.includes('localhost')) {
            modifiedParts.push(part);
          }
          return;
        }
        if (part.toLowerCase().startsWith('samesite=')) {
          // Modify SameSite attribute
          modifiedParts.push('SameSite=Lax');
          return;
        }
        modifiedParts.push(part);
      });

      return modifiedParts.join('; ');
    });
  }

  sendResponse(res, data, headers, status) {
    // Set response headers
    Object.entries(headers).forEach(([key, value]) => {
      if (value !== undefined) {
        res.set(key, value);
      }
    });

    // Set status code
    res.status(status);

    // Send response
    res.send(data);
  }

  isTextContent(contentType) {
    const textTypes = [
      'text/',
      'application/javascript',
      'application/json',
      'application/xml',
      'application/xhtml+xml',
      'application/x-javascript'
    ];

    return textTypes.some(type => contentType.includes(type));
  }

  getEncoding(headers) {
    const contentType = headers['content-type'] || '';
    const match = contentType.match(/charset=([^;]+)/);
    return match ? match[1].trim() : 'utf-8';
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

    // Limit cache size
    if (this.cache.size > 1000) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }

    this.cache.set(url, {
      ...response,
      timestamp: Date.now()
    });
  }

  clearCache() {
    this.cache.clear();
  }
}

module.exports = ProxyHandler;