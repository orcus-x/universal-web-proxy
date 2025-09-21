const cheerio = require('cheerio');

class HTMLModifier {
  constructor(urlRewriter) {
    this.urlRewriter = urlRewriter;
  }

  modifyHtml(html, pageUrl) {
    const $ = cheerio.load(html, {
      decodeEntities: false,
      xmlMode: false
    });

    // Add base tag if not present
    if (!$('base').length) {
      $('head').prepend(this.urlRewriter.createBaseTag());
    }

    // Rewrite all URLs in various attributes
    this.rewriteUrls($, pageUrl);

    // Inject client-side proxy script
    this.injectProxyScript($);

    // Modify forms
    this.modifyForms($, pageUrl);

    // Handle meta refresh
    this.handleMetaRefresh($, pageUrl);

    return $.html();
  }

  rewriteUrls($, pageUrl) {
    // Rewrite href attributes
    $('a[href]').each((i, elem) => {
      const href = $(elem).attr('href');
      $(elem).attr('href', this.urlRewriter.toProxyUrl(href, pageUrl));
    });

    // Rewrite src attributes
    $('[src]').each((i, elem) => {
      const src = $(elem).attr('src');
      $(elem).attr('src', this.urlRewriter.toProxyUrl(src, pageUrl));
    });

    // Rewrite srcset attributes (for responsive images)
    $('[srcset]').each((i, elem) => {
      const srcset = $(elem).attr('srcset');
      $(elem).attr('srcset', this.urlRewriter.rewriteSrcset(srcset, pageUrl));
    });

    // Rewrite action attributes in forms
    $('form[action]').each((i, elem) => {
      const action = $(elem).attr('action');
      $(elem).attr('action', this.urlRewriter.toProxyUrl(action, pageUrl));
    });

    // Rewrite link tags
    $('link[href]').each((i, elem) => {
      const href = $(elem).attr('href');
      $(elem).attr('href', this.urlRewriter.toProxyUrl(href, pageUrl));
    });

    // Rewrite style attributes with url()
    $('[style]').each((i, elem) => {
      const style = $(elem).attr('style');
      if (style && style.includes('url(')) {
        $(elem).attr('style', this.urlRewriter.rewriteCss(style, pageUrl));
      }
    });

    // Rewrite inline styles
    $('style').each((i, elem) => {
      const css = $(elem).html();
      if (css) {
        $(elem).html(this.urlRewriter.rewriteCss(css, pageUrl));
      }
    });

    // Rewrite inline scripts (basic)
    $('script').each((i, elem) => {
      const script = $(elem).html();
      if (script && !$(elem).attr('src')) {
        $(elem).html(this.urlRewriter.rewriteJavaScript(script, pageUrl));
      }
    });

    // Rewrite data attributes that might contain URLs
    $('[data-src], [data-href], [data-url]').each((i, elem) => {
      ['data-src', 'data-href', 'data-url'].forEach(attr => {
        const value = $(elem).attr(attr);
        if (value) {
          $(elem).attr(attr, this.urlRewriter.toProxyUrl(value, pageUrl));
        }
      });
    });

    // Rewrite poster attribute for videos
    $('video[poster]').each((i, elem) => {
      const poster = $(elem).attr('poster');
      $(elem).attr('poster', this.urlRewriter.toProxyUrl(poster, pageUrl));
    });
  }

  modifyForms($, pageUrl) {
    // Ensure forms submit to proxy
    $('form').each((i, elem) => {
      const form = $(elem);

      // If no action, set to current page
      if (!form.attr('action')) {
        form.attr('action', pageUrl);
      }

      // Add hidden field with original domain info if needed
      // form.append('<input type="hidden" name="_proxy_origin" value="' + this.urlRewriter.targetBase + '">');
    });
  }

  handleMetaRefresh($, pageUrl) {
    $('meta[http-equiv="refresh"]').each((i, elem) => {
      const content = $(elem).attr('content');
      if (content) {
        const match = content.match(/^\d+;\s*url=(.+)$/i);
        if (match) {
          const url = match[1];
          const newUrl = this.urlRewriter.toProxyUrl(url, pageUrl);
          $(elem).attr('content', content.replace(url, newUrl));
        }
      }
    });
  }

  injectProxyScript($) {
    // Inject client-side script to handle dynamic content
    const proxyScript = `
      <script>
        (function() {
          // Store original fetch and XMLHttpRequest
          const originalFetch = window.fetch;
          const OriginalXHR = window.XMLHttpRequest;

          // Helper function to rewrite URLs
          function rewriteUrl(url) {
            try {
              const targetBase = '${this.urlRewriter.targetBase}';
              const proxyHost = '${this.urlRewriter.getProxyProtocol()}://${this.urlRewriter.proxyHost}';

              // Convert relative URLs to absolute
              const absoluteUrl = new URL(url, window.location.href);

              // If URL is from target domain, rewrite it
              if (absoluteUrl.href.includes(targetBase)) {
                return absoluteUrl.href.replace(targetBase, proxyHost);
              }

              // Check if it's a relative URL that needs rewriting
              if (!url.startsWith('http') && !url.startsWith('//')) {
                return new URL(url, proxyHost).href;
              }

              return url;
            } catch (e) {
              return url;
            }
          }

          // Override fetch
          window.fetch = function(url, options = {}) {
            const rewrittenUrl = rewriteUrl(url.toString());
            return originalFetch(rewrittenUrl, options);
          };

          // Override XMLHttpRequest
          window.XMLHttpRequest = function() {
            const xhr = new OriginalXHR();
            const originalOpen = xhr.open;

            xhr.open = function(method, url, ...args) {
              const rewrittenUrl = rewriteUrl(url);
              return originalOpen.call(this, method, rewrittenUrl, ...args);
            };

            return xhr;
          };

          // Handle dynamic link clicks
          document.addEventListener('click', function(e) {
            const target = e.target.closest('a');
            if (target && target.href) {
              const rewrittenUrl = rewriteUrl(target.href);
              if (rewrittenUrl !== target.href) {
                e.preventDefault();
                window.location.href = rewrittenUrl;
              }
            }
          });

          // Override history API
          const originalPushState = history.pushState;
          const originalReplaceState = history.replaceState;

          history.pushState = function(state, title, url) {
            if (url) {
              url = rewriteUrl(url);
            }
            return originalPushState.call(this, state, title, url);
          };

          history.replaceState = function(state, title, url) {
            if (url) {
              url = rewriteUrl(url);
            }
            return originalReplaceState.call(this, state, title, url);
          };
        })();
      </script>
    `;

    $('head').append(proxyScript);
  }
}

module.exports = HTMLModifier;