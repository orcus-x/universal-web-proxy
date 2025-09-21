const { URL } = require('url');

class URLRewriter {
  constructor(targetUrl, proxyHost) {
    this.targetUrl = new URL(targetUrl);
    this.proxyHost = proxyHost;
    this.targetBase = `${this.targetUrl.protocol}//${this.targetUrl.host}`;
  }

  // Convert target URL to proxy URL
  toProxyUrl(url, baseUrl = this.targetBase) {
    try {
      // Handle various URL formats
      if (!url) return url;

      // Data URLs and special protocols should not be rewritten
      if (url.startsWith('data:') || url.startsWith('javascript:') || url.startsWith('mailto:')) {
        return url;
      }

      // Handle protocol-relative URLs
      if (url.startsWith('//')) {
        url = `${this.targetUrl.protocol}${url}`;
      }

      // Convert to absolute URL
      const absoluteUrl = new URL(url, baseUrl);

      // If URL is from a different domain, leave it as is (for now)
      if (absoluteUrl.host !== this.targetUrl.host && !url.startsWith('/')) {
        return url;
      }

      // Replace the host with proxy host
      const proxyUrl = absoluteUrl.href.replace(
        absoluteUrl.origin,
        `${this.getProxyProtocol()}://${this.proxyHost}`
      );

      return proxyUrl;
    } catch (e) {
      // If URL parsing fails, try simple string replacement
      if (url.startsWith('/')) {
        return url;
      }
      return url;
    }
  }

  // Convert proxy URL back to target URL
  toTargetUrl(url) {
    try {
      if (!url) return url;

      const proxyUrl = new URL(url, `${this.getProxyProtocol()}://${this.proxyHost}`);

      // Replace proxy host with target host
      const targetUrl = proxyUrl.href.replace(
        `${this.getProxyProtocol()}://${this.proxyHost}`,
        this.targetBase
      );

      return targetUrl;
    } catch (e) {
      return url;
    }
  }

  // Rewrite URLs in CSS content
  rewriteCss(css, baseUrl) {
    // Handle url() in CSS
    return css.replace(/url\(['"]?([^'")\s]+)['"]?\)/g, (match, url) => {
      const newUrl = this.toProxyUrl(url, baseUrl);
      return `url('${newUrl}')`;
    });
  }

  // Rewrite URLs in JavaScript content
  rewriteJavaScript(js, baseUrl) {
    // This is basic rewriting - more sophisticated parsing might be needed
    // for complex JavaScript applications

    // Replace common fetch/ajax patterns
    js = js.replace(/(fetch|axios\.get|axios\.post|\.ajax)\(['"]([^'"]+)['"]/g, (match, method, url) => {
      const newUrl = this.toProxyUrl(url, baseUrl);
      return `${method}('${newUrl}'`;
    });

    // Replace location assignments
    js = js.replace(/location\.href\s*=\s*['"]([^'"]+)['"]/g, (match, url) => {
      const newUrl = this.toProxyUrl(url, baseUrl);
      return `location.href = '${newUrl}'`;
    });

    return js;
  }

  // Get proxy protocol (http/https) based on environment
  getProxyProtocol() {
    if (process.env.VERCEL_URL) {
      return 'https';
    }
    return this.proxyHost.includes('localhost') ? 'http' : 'https';
  }

  // Create base tag for HTML
  createBaseTag() {
    return `<base href="${this.getProxyProtocol()}://${this.proxyHost}/">`;
  }

  // Rewrite srcset attribute (for responsive images)
  rewriteSrcset(srcset, baseUrl) {
    return srcset.split(',').map(src => {
      const [url, descriptor] = src.trim().split(/\s+/);
      const newUrl = this.toProxyUrl(url, baseUrl);
      return descriptor ? `${newUrl} ${descriptor}` : newUrl;
    }).join(', ');
  }
}

module.exports = URLRewriter;