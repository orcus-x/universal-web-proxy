const crypto = require('crypto');
const tls = require('tls');
const http2 = require('http2');
const { URL } = require('url');

/**
 * Cloudflare Bypass Module
 * Implements advanced techniques to bypass Cloudflare protection
 */
class CloudflareBypass {
  constructor() {
    // Chrome 122 JA3 fingerprint components
    this.ja3Config = {
      // TLS version
      tlsVersion: '771',

      // Cipher suites (Chrome order)
      cipherSuites: [
        0x1301, // TLS_AES_128_GCM_SHA256
        0x1302, // TLS_AES_256_GCM_SHA384
        0x1303, // TLS_CHACHA20_POLY1305_SHA256
        0xc02b, // TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256
        0xc02f, // TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256
        0xc02c, // TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384
        0xc030, // TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384
        0xcca9, // TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256
        0xcca8, // TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256
        0xc013, // TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA
        0xc014, // TLS_ECDHE_RSA_WITH_AES_256_CBC_SHA
      ],

      // TLS extensions (Chrome order)
      extensions: [
        0,      // server_name
        17,     // status_request
        43,     // supported_versions
        51,     // key_share
        13,     // signature_algorithms
        10,     // supported_groups
        16,     // application_layer_protocol_negotiation
        5,      // status_request_v2
        18,     // signed_certificate_timestamp
        23,     // extended_master_secret
        27,     // compress_certificate
        35,     // session_ticket
        45,     // psk_key_exchange_modes
        65281,  // renegotiation_info
      ],

      // Elliptic curves
      curves: [
        0x001d, // X25519
        0x0017, // secp256r1
        0x0018, // secp384r1
      ],

      // Signature algorithms
      signatureAlgorithms: [
        0x0403, // ecdsa_secp256r1_sha256
        0x0503, // ecdsa_secp384r1_sha384
        0x0603, // ecdsa_secp521r1_sha512
        0x0804, // rsa_pss_rsae_sha256
        0x0805, // rsa_pss_rsae_sha384
        0x0806, // rsa_pss_rsae_sha512
        0x0401, // rsa_pkcs1_sha256
        0x0501, // rsa_pkcs1_sha384
        0x0601, // rsa_pkcs1_sha512
      ],
    };

    // HTTP/2 settings (Chrome values)
    this.http2Settings = {
      headerTableSize: 65536,
      maxConcurrentStreams: 1000,
      initialWindowSize: 6291456,
      maxFrameSize: 16777215,
      maxHeaderListSize: 262144,
    };

    // Chrome pseudo-headers order
    this.headerOrder = [
      ':method',
      ':authority',
      ':scheme',
      ':path',
    ];
  }

  /**
   * Create TLS socket with Chrome fingerprint
   */
  createTLSSocket(host, port = 443) {
    const options = {
      host,
      port,
      servername: host,

      // ALPN negotiation
      ALPNProtocols: ['h2', 'http/1.1'],

      // Cipher configuration
      ciphers: this.getCipherString(),

      // TLS options
      minVersion: 'TLSv1.2',
      maxVersion: 'TLSv1.3',

      // Disable compression
      requestOCSP: true,

      // Session resumption
      sessionIdContext: crypto.randomBytes(32).toString('hex'),

      // Security options
      rejectUnauthorized: false,

      // Honor cipher order
      honorCipherOrder: true,

      // ECDHCurve
      ecdhCurve: 'X25519:P-256:P-384',
    };

    return new Promise((resolve, reject) => {
      const socket = tls.connect(options, () => {
        if (!socket.authorized && socket.authorizationError) {
          // Ignore cert errors for Cloudflare
        }
        resolve(socket);
      });

      socket.on('error', reject);
    });
  }

  /**
   * Create HTTP/2 session with Chrome fingerprint
   */
  createHTTP2Session(url) {
    const parsedUrl = new URL(url);

    const session = http2.connect(parsedUrl.origin, {
      // Chrome HTTP/2 settings
      settings: this.http2Settings,

      // ALPN
      ALPNProtocols: ['h2'],

      // TLS options
      servername: parsedUrl.hostname,
      checkServerIdentity: () => undefined,
      rejectUnauthorized: false,

      // Cipher suites
      ciphers: this.getCipherString(),

      // Session
      sessionIdContext: crypto.randomBytes(32).toString('hex'),

      // Curves
      ecdhCurve: 'X25519:P-256:P-384',
    });

    // Set Chrome window update strategy
    session.on('localSettings', (settings) => {
      session.setLocalWindowSize(6291456);
    });

    return session;
  }

  /**
   * Get cipher string for TLS
   */
  getCipherString() {
    // Chrome cipher order
    return [
      'TLS_AES_128_GCM_SHA256',
      'TLS_AES_256_GCM_SHA384',
      'TLS_CHACHA20_POLY1305_SHA256',
      'ECDHE-ECDSA-AES128-GCM-SHA256',
      'ECDHE-RSA-AES128-GCM-SHA256',
      'ECDHE-ECDSA-AES256-GCM-SHA384',
      'ECDHE-RSA-AES256-GCM-SHA384',
      'ECDHE-ECDSA-CHACHA20-POLY1305',
      'ECDHE-RSA-CHACHA20-POLY1305',
      'ECDHE-RSA-AES128-SHA',
      'ECDHE-RSA-AES256-SHA',
    ].join(':');
  }

  /**
   * Make HTTP/2 request with Chrome fingerprint
   */
  async makeHTTP2Request(url, options = {}) {
    const parsedUrl = new URL(url);
    const session = this.createHTTP2Session(url);

    return new Promise((resolve, reject) => {
      const headers = this.buildHTTP2Headers(parsedUrl, options);

      const stream = session.request(headers, {
        endStream: !options.body,
        weight: 256,
        exclusive: false,
      });

      let data = '';
      let responseHeaders = {};

      stream.on('response', (headers) => {
        responseHeaders = headers;
      });

      stream.on('data', (chunk) => {
        data += chunk.toString();
      });

      stream.on('end', () => {
        session.close();
        resolve({
          status: responseHeaders[':status'],
          headers: responseHeaders,
          body: data,
        });
      });

      stream.on('error', (err) => {
        session.close();
        reject(err);
      });

      if (options.body) {
        stream.write(options.body);
      }

      stream.end();
    });
  }

  /**
   * Build HTTP/2 headers with Chrome order
   */
  buildHTTP2Headers(parsedUrl, options) {
    const headers = {
      ':method': options.method || 'GET',
      ':authority': parsedUrl.host,
      ':scheme': parsedUrl.protocol.replace(':', ''),
      ':path': parsedUrl.pathname + parsedUrl.search,

      // Chrome headers
      'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
      'accept-encoding': 'gzip, deflate, br',
      'accept-language': 'en-US,en;q=0.9',
      'cache-control': 'no-cache',
      'pragma': 'no-cache',
      'sec-ch-ua': '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'sec-fetch-dest': 'document',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-site': 'none',
      'sec-fetch-user': '?1',
      'upgrade-insecure-requests': '1',
      'user-agent': options.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    };

    // Add custom headers
    if (options.headers) {
      Object.assign(headers, options.headers);
    }

    return headers;
  }

  /**
   * Solve Cloudflare JS challenge
   */
  async solveChallenge(html, url) {
    // Check if it's a challenge page
    if (!html.includes('cf-browser-verification') &&
        !html.includes('checking_browser') &&
        !html.includes('cf-challenge')) {
      return null;
    }

    console.log('Cloudflare challenge detected, attempting to solve...');

    // Extract challenge parameters
    const challengeMatch = html.match(/name="jschl_vc" value="([^"]+)"/);
    const passMatch = html.match(/name="pass" value="([^"]+)"/);
    const rMatch = html.match(/name="r" value="([^"]+)"/);

    if (!challengeMatch || !passMatch) {
      console.log('Could not extract challenge parameters');
      return null;
    }

    const jschl_vc = challengeMatch[1];
    const pass = passMatch[1];
    const r = rMatch ? rMatch[1] : '';

    // Extract and solve the JavaScript challenge
    const challengeScript = this.extractChallengeScript(html);
    if (!challengeScript) {
      console.log('Could not extract challenge script');
      return null;
    }

    // Calculate the answer
    const answer = this.calculateAnswer(challengeScript, url);

    // Build challenge solution
    const parsedUrl = new URL(url);
    const solution = {
      jschl_vc: jschl_vc,
      pass: pass,
      r: r,
      jschl_answer: answer,
    };

    // Wait 4 seconds (Cloudflare requirement)
    await new Promise(resolve => setTimeout(resolve, 4000));

    // Submit solution
    const submitUrl = `${parsedUrl.origin}/cdn-cgi/l/chk_jschl?${new URLSearchParams(solution)}`;

    return submitUrl;
  }

  /**
   * Extract challenge script from HTML
   */
  extractChallengeScript(html) {
    const scriptMatch = html.match(/setTimeout\(function\(\)\{([\s\S]+?)\}, 4000\)/);
    if (!scriptMatch) {
      return null;
    }

    return scriptMatch[1];
  }

  /**
   * Calculate challenge answer
   */
  calculateAnswer(script, url) {
    try {
      // Parse the domain for the calculation
      const domain = new URL(url).hostname;
      const domainLength = domain.length;

      // Extract the initial value
      const initialMatch = script.match(/a\.value\s*=\s*([\d\.\+\-\*\/\(\)]+)/);
      if (!initialMatch) {
        return 0;
      }

      // Evaluate the expression (safely)
      let answer = this.safeEval(initialMatch[1]);

      // Apply domain length
      answer += domainLength;

      return answer.toFixed(10);
    } catch (e) {
      console.error('Failed to calculate answer:', e);
      return 0;
    }
  }

  /**
   * Safe evaluation of mathematical expressions
   */
  safeEval(expr) {
    // Remove any non-mathematical characters
    const cleaned = expr.replace(/[^0-9\.\+\-\*\/\(\)]/g, '');

    // Create a safe evaluation context
    const func = new Function('return ' + cleaned);
    return func();
  }

  /**
   * Check if response is a Cloudflare challenge
   */
  isCloudflareChallenge(html) {
    return html && (
      html.includes('cf-browser-verification') ||
      html.includes('Checking your browser') ||
      html.includes('cf-challenge') ||
      html.includes('jschl-answer') ||
      (html.includes('Cloudflare') && html.includes('Ray ID'))
    );
  }

  /**
   * Generate random TLS session ID
   */
  generateSessionId() {
    return crypto.randomBytes(32);
  }

  /**
   * Generate Chrome-like headers
   */
  generateChromeHeaders(url) {
    const parsedUrl = new URL(url);

    return {
      'Host': parsedUrl.host,
      'Connection': 'keep-alive',
      'Cache-Control': 'max-age=0',
      'sec-ch-ua': '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'Upgrade-Insecure-Requests': '1',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-User': '?1',
      'Sec-Fetch-Dest': 'document',
      'Accept-Encoding': 'gzip, deflate, br',
      'Accept-Language': 'en-US,en;q=0.9',
    };
  }
}

module.exports = CloudflareBypass;