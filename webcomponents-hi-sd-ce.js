(function () {
'use strict';

/**
 * @license
 * Copyright (c) 2016 The Polymer Project Authors. All rights reserved.
 * This code may only be used under the BSD style license found at http://polymer.github.io/LICENSE.txt
 * The complete set of authors may be found at http://polymer.github.io/AUTHORS.txt
 * The complete set of contributors may be found at http://polymer.github.io/CONTRIBUTORS.txt
 * Code distributed by Google as part of the polymer project is also
 * subject to an additional IP rights grant found at http://polymer.github.io/PATENTS.txt
 */
(scope => {

  /********************* base setup *********************/
  const link = document.createElement('link');
  const useNative = Boolean('import' in link);
  const emptyNodeList = link.querySelectorAll('*');

  // Polyfill `currentScript` for browsers without it.
  let currentScript = null;
  if ('currentScript' in document === false) {
    Object.defineProperty(document, 'currentScript', {
      get() {
        return currentScript ||
          // NOTE: only works when called in synchronously executing code.
          // readyState should check if `loading` but IE10 is
          // interactive when scripts run so we cheat. This is not needed by
          // html-imports polyfill but helps generally polyfill `currentScript`.
          (document.readyState !== 'complete' ?
            document.scripts[document.scripts.length - 1] : null);
      },
      configurable: true
    });
  }

  /**
   * @param {Array|NodeList|NamedNodeMap} list
   * @param {!Function} callback
   * @param {boolean=} inverseOrder
   */
  const forEach = (list, callback, inverseOrder) => {
    const length = list ? list.length : 0;
    const increment = inverseOrder ? -1 : 1;
    let i = inverseOrder ? length - 1 : 0;
    for (; i < length && i >= 0; i = i + increment) {
      callback(list[i], i);
    }
  };

  /**
   * @param {!Node} node
   * @param {!string} selector
   * @return {!NodeList<!Element>}
   */
  const QSA = (node, selector) => {
    // IE 11 throws a SyntaxError if a node with no children is queried with
    // a selector containing the `:not([type])` syntax.
    if (!node.childNodes.length) {
      return emptyNodeList;
    }
    return node.querySelectorAll(selector);
  };

  /**
   * @param {!DocumentFragment} fragment
   */
  const replaceScripts = (fragment) => {
    forEach(QSA(fragment, 'template'), template => {
      forEach(QSA(template.content, scriptsSelector), script => {
        const clone = /** @type {!HTMLScriptElement} */
          (document.createElement('script'));
        forEach(script.attributes, attr => clone.setAttribute(attr.name, attr.value));
        clone.textContent = script.textContent;
        script.parentNode.replaceChild(clone, script);
      });
      replaceScripts(template.content);
    });
  };

  /********************* path fixup *********************/
  const CSS_URL_REGEXP = /(url\()([^)]*)(\))/g;
  const CSS_IMPORT_REGEXP = /(@import[\s]+(?!url\())([^;]*)(;)/g;
  const STYLESHEET_REGEXP = /(<link[^>]*)(rel=['|"]?stylesheet['|"]?[^>]*>)/g;

  // path fixup: style elements in imports must be made relative to the main
  // document. We fixup url's in url() and @import.
  const Path = {

    fixUrls(element, base) {
      if (element.href) {
        element.setAttribute('href',
          Path.resolveUrl(element.getAttribute('href'), base));
      }
      if (element.src) {
        element.setAttribute('src',
          Path.resolveUrl(element.getAttribute('src'), base));
      }
      if (element.localName === 'style') {
        const r = Path.replaceUrls(element.textContent, base, CSS_URL_REGEXP);
        element.textContent = Path.replaceUrls(r, base, CSS_IMPORT_REGEXP);
      }
    },

    replaceUrls(text, linkUrl, regexp) {
      return text.replace(regexp, (m, pre, url, post) => {
        let urlPath = url.replace(/["']/g, '');
        if (linkUrl) {
          urlPath = Path.resolveUrl(urlPath, linkUrl);
        }
        return pre + '\'' + urlPath + '\'' + post;
      });
    },

    resolveUrl(url, base) {
      // Lazy feature detection.
      if (Path.__workingURL === undefined) {
        Path.__workingURL = false;
        try {
          const u = new URL('b', 'http://a');
          u.pathname = 'c%20d';
          Path.__workingURL = (u.href === 'http://a/c%20d');
        } catch (e) {}
      }

      if (Path.__workingURL) {
        return (new URL(url, base)).href;
      }

      // Fallback to creating an anchor into a disconnected document.
      let doc = Path.__tempDoc;
      if (!doc) {
        doc = document.implementation.createHTMLDocument('temp');
        Path.__tempDoc = doc;
        doc.__base = doc.createElement('base');
        doc.head.appendChild(doc.__base);
        doc.__anchor = doc.createElement('a');
      }
      doc.__base.href = base;
      doc.__anchor.href = url;
      return doc.__anchor.href || url;
    }
  };

  /********************* Xhr processor *********************/
  const Xhr = {

    async: true,

    /**
     * @param {!string} url
     * @param {!function(!string, string=)} success
     * @param {!function(!string)} fail
     */
    load(url, success, fail) {
      if (!url) {
        fail('error: href must be specified');
      } else if (url.match(/^data:/)) {
        // Handle Data URI Scheme
        const pieces = url.split(',');
        const header = pieces[0];
        let resource = pieces[1];
        if (header.indexOf(';base64') > -1) {
          resource = atob(resource);
        } else {
          resource = decodeURIComponent(resource);
        }
        success(resource);
      } else {
        const request = new XMLHttpRequest();
        request.open('GET', url, Xhr.async);
        request.onload = () => {
          // Servers redirecting an import can add a Location header to help us
          // polyfill correctly. Handle relative and full paths.
          // Prefer responseURL which already resolves redirects
          // https://xhr.spec.whatwg.org/#the-responseurl-attribute
          let redirectedUrl = request.responseURL || request.getResponseHeader('Location');
          if (redirectedUrl && redirectedUrl.indexOf('/') === 0) {
            // In IE location.origin might not work
            // https://connect.microsoft.com/IE/feedback/details/1763802/location-origin-is-undefined-in-ie-11-on-windows-10-but-works-on-windows-7
            const origin = (location.origin || location.protocol + '//' + location.host);
            redirectedUrl = origin + redirectedUrl;
          }
          const resource = /** @type {string} */ (request.response || request.responseText);
          if (request.status === 304 || request.status === 0 ||
            request.status >= 200 && request.status < 300) {
            success(resource, redirectedUrl);
          } else {
            fail(resource);
          }
        };
        request.onreadystatechange = function (oEvent) {
          if (request.readyState === 4) { // done
            if (request.status !== 200) {
              const resource = /** @type {string} */ (request.response || request.responseText);
              fail(resource);
            }
          }
        };
        request.send();
      }
    }
  };

  /********************* importer *********************/

  const isIE = /Trident/.test(navigator.userAgent) ||
    /Edge\/\d./i.test(navigator.userAgent);

  const importSelector = 'link[rel=import]';

  // Used to disable loading of resources.
  const importDisableType = 'import-disable';

  const disabledLinkSelector = `link[rel=stylesheet][href][type=${importDisableType}]`;

  const scriptsSelector = `script:not([type]),script[type="application/javascript"],` +
    `script[type="text/javascript"]`;

  const importDependenciesSelector = `${importSelector},${disabledLinkSelector},` +
    `style:not([type]),link[rel=stylesheet][href]:not([type]),` + scriptsSelector;

  const importDependencyAttr = 'import-dependency';

  const rootImportSelector = `${importSelector}:not([${importDependencyAttr}])`;

  const pendingScriptsSelector = `script[${importDependencyAttr}]`;

  const pendingStylesSelector = `style[${importDependencyAttr}],` +
    `link[rel=stylesheet][${importDependencyAttr}]`;

  /**
   * Importer will:
   * - load any linked import documents (with deduping)
   * - whenever an import is loaded, prompt the parser to try to parse
   * - observe imported documents for new elements (these are handled via the
   *   dynamic importer)
   */
  class Importer {
    constructor() {
      this.documents = {};
      // Used to keep track of pending loads, so that flattening and firing of
      // events can be done when all resources are ready.
      this.inflight = 0;
      this.dynamicImportsMO = new MutationObserver(m => this.handleMutations(m));
      // Observe changes on <head>.
      this.dynamicImportsMO.observe(document.head, {
        childList: true,
        subtree: true
      });
      // 1. Load imports contents
      // 2. Assign them to first import links on the document
      // 3. Wait for import styles & scripts to be done loading/running
      // 4. Fire load/error events
      this.loadImports(document);
    }

    /**
     * @param {!(HTMLDocument|DocumentFragment|Element)} doc
     */
    loadImports(doc) {
      const links = /** @type {!NodeList<!HTMLLinkElement>} */
        (QSA(doc, importSelector));
      forEach(links, link => this.loadImport(link));
    }

    /**
     * @param {!HTMLLinkElement} link
     */
    loadImport(link) {
      const url = link.href;
      // This resource is already being handled by another import.
      if (this.documents[url] !== undefined) {
        // If import is already loaded, we can safely associate it to the link
        // and fire the load/error event.
        const imp = this.documents[url];
        if (imp && imp['__loaded']) {
          link['__import'] = imp;
          this.fireEventIfNeeded(link);
        }
        return;
      }
      this.inflight++;
      // Mark it as pending to notify others this url is being loaded.
      this.documents[url] = 'pending';
      Xhr.load(url, (resource, redirectedUrl) => {
        const doc = this.makeDocument(resource, redirectedUrl || url);
        this.documents[url] = doc;
        this.inflight--;
        // Load subtree.
        this.loadImports(doc);
        this.processImportsIfLoadingDone();
      }, () => {
        // If load fails, handle error.
        this.documents[url] = null;
        this.inflight--;
        this.processImportsIfLoadingDone();
      });
    }

    /**
     * Creates a new document containing resource and normalizes urls accordingly.
     * @param {string=} resource
     * @param {string=} url
     * @return {!DocumentFragment}
     */
    makeDocument(resource, url) {
      if (!resource) {
        return document.createDocumentFragment();
      }

      if (isIE) {
        // <link rel=stylesheet> should be appended to <head>. Not doing so
        // in IE/Edge breaks the cascading order. We disable the loading by
        // setting the type before setting innerHTML to avoid loading
        // resources twice.
        resource = resource.replace(STYLESHEET_REGEXP, (match, p1, p2) => {
          if (match.indexOf('type=') === -1) {
            return `${p1} type=${importDisableType} ${p2}`;
          }
          return match;
        });
      }

      let content;
      const template = /** @type {!HTMLTemplateElement} */
        (document.createElement('template'));
      template.innerHTML = resource;
      if (template.content) {
        content = template.content;
        // Clone scripts inside templates since they won't execute when the
        // hosting template is cloned.
        replaceScripts(content);
      } else {
        // <template> not supported, create fragment and move content into it.
        content = document.createDocumentFragment();
        while (template.firstChild) {
          content.appendChild(template.firstChild);
        }
      }

      // Support <base> in imported docs. Resolve url and remove its href.
      const baseEl = content.querySelector('base');
      if (baseEl) {
        url = Path.resolveUrl(baseEl.getAttribute('href'), url);
        baseEl.removeAttribute('href');
      }

      const n$ = /** @type {!NodeList<!(HTMLLinkElement|HTMLScriptElement|HTMLStyleElement)>} */
        (QSA(content, importDependenciesSelector));
      // For source map hints.
      let inlineScriptIndex = 0;
      forEach(n$, n => {
        // Listen for load/error events, then fix urls.
        whenElementLoaded(n);
        Path.fixUrls(n, url);
        // Mark for easier selectors.
        n.setAttribute(importDependencyAttr, '');
        // Generate source map hints for inline scripts.
        if (n.localName === 'script' && !n.src && n.textContent) {
          const num = inlineScriptIndex ? `-${inlineScriptIndex}` : '';
          const content = n.textContent + `\n//# sourceURL=${url}${num}.js\n`;
          // We use the src attribute so it triggers load/error events, and it's
          // easier to capture errors (e.g. parsing) like this.
          n.setAttribute('src', 'data:text/javascript;charset=utf-8,' + encodeURIComponent(content));
          n.textContent = '';
          inlineScriptIndex++;
        }
      });
      return content;
    }

    /**
     * Waits for loaded imports to finish loading scripts and styles, then fires
     * the load/error events.
     */
    processImportsIfLoadingDone() {
      // Wait until all resources are ready, then load import resources.
      if (this.inflight) return;

      // Stop observing, flatten & load resource, then restart observing <head>.
      this.dynamicImportsMO.disconnect();
      this.flatten(document);
      // We wait for styles to load, and at the same time we execute the scripts,
      // then fire the load/error events for imports to have faster whenReady
      // callback execution.
      // NOTE: This is different for native behavior where scripts would be
      // executed after the styles before them are loaded.
      // To achieve that, we could select pending styles and scripts in the
      // document and execute them sequentially in their dom order.
      let scriptsOk = false,
        stylesOk = false;
      const onLoadingDone = () => {
        if (stylesOk && scriptsOk) {
          // Catch any imports that might have been added while we
          // weren't looking, wait for them as well.
          this.loadImports(document);
          if (this.inflight) return;

          // Restart observing.
          this.dynamicImportsMO.observe(document.head, {
            childList: true,
            subtree: true
          });
          this.fireEvents();
        }
      };
      this.waitForStyles(() => {
        stylesOk = true;
        onLoadingDone();
      });
      this.runScripts(() => {
        scriptsOk = true;
        onLoadingDone();
      });
    }

    /**
     * @param {!HTMLDocument} doc
     */
    flatten(doc) {
      const n$ = /** @type {!NodeList<!HTMLLinkElement>} */
        (QSA(doc, importSelector));
      forEach(n$, n => {
        const imp = this.documents[n.href];
        n['__import'] = /** @type {!Document} */ (imp);
        if (imp && imp.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
          // We set the .import to be the link itself, and update its readyState.
          // Other links with the same href will point to this link.
          this.documents[n.href] = n;
          n.readyState = 'loading';
          n['__import'] = n;
          this.flatten(imp);
          n.appendChild(imp);
        }
      });
    }

    /**
     * Replaces all the imported scripts with a clone in order to execute them.
     * Updates the `currentScript`.
     * @param {!function()} callback
     */
    runScripts(callback) {
      const s$ = QSA(document, pendingScriptsSelector);
      const l = s$.length;
      const cloneScript = i => {
        if (i < l) {
          // The pending scripts have been generated through innerHTML and
          // browsers won't execute them for security reasons. We cannot use
          // s.cloneNode(true) either, the only way to run the script is manually
          // creating a new element and copying its attributes.
          const s = s$[i];
          const clone = /** @type {!HTMLScriptElement} */
            (document.createElement('script'));
          // Remove import-dependency attribute to avoid double cloning.
          s.removeAttribute(importDependencyAttr);
          forEach(s.attributes, attr => clone.setAttribute(attr.name, attr.value));
          // Update currentScript and replace original with clone script.
          currentScript = clone;
          s.parentNode.replaceChild(clone, s);
          whenElementLoaded(clone, () => {
            currentScript = null;
            cloneScript(i + 1);
          });
        } else {
          callback();
        }
      };
      cloneScript(0);
    }

    /**
     * Waits for all the imported stylesheets/styles to be loaded.
     * @param {!function()} callback
     */
    waitForStyles(callback) {
      const s$ = /** @type {!NodeList<!(HTMLLinkElement|HTMLStyleElement)>} */
        (QSA(document, pendingStylesSelector));
      let pending = s$.length;
      if (!pending) {
        callback();
        return;
      }
      // <link rel=stylesheet> should be appended to <head>. Not doing so
      // in IE/Edge breaks the cascading order
      // https://developer.microsoft.com/en-us/microsoft-edge/platform/issues/10472273/
      // If there is one <link rel=stylesheet> imported, we must move all imported
      // links and styles to <head>.
      const needsMove = isIE && !!document.querySelector(disabledLinkSelector);
      forEach(s$, s => {
        // Listen for load/error events, remove selector once is done loading.
        whenElementLoaded(s, () => {
          s.removeAttribute(importDependencyAttr);
          if (--pending === 0) {
            callback();
          }
        });
        // Check if was already moved to head, to handle the case where the element
        // has already been moved but it is still loading.
        if (needsMove && s.parentNode !== document.head) {
          // Replace the element we're about to move with a placeholder.
          const placeholder = document.createElement(s.localName);
          // Add reference of the moved element.
          placeholder['__appliedElement'] = s;
          // Disable this from appearing in document.styleSheets.
          placeholder.setAttribute('type', 'import-placeholder');
          // Append placeholder next to the sibling, and move original to <head>.
          s.parentNode.insertBefore(placeholder, s.nextSibling);
          let newSibling = importForElement(s);
          while (newSibling && importForElement(newSibling)) {
            newSibling = importForElement(newSibling);
          }
          if (newSibling.parentNode !== document.head) {
            newSibling = null;
          }
          document.head.insertBefore(s, newSibling);
          // Enable the loading of <link rel=stylesheet>.
          s.removeAttribute('type');
        }
      });
    }

    /**
     * Fires load/error events for imports in the right order .
     */
    fireEvents() {
      const n$ = /** @type {!NodeList<!HTMLLinkElement>} */
        (QSA(document, importSelector));
      // Inverse order to have events firing bottom-up.
      forEach(n$, n => this.fireEventIfNeeded(n), true);
    }

    /**
     * Fires load/error event for the import if this wasn't done already.
     * @param {!HTMLLinkElement} link
     */
    fireEventIfNeeded(link) {
      // Don't fire twice same event.
      if (!link['__loaded']) {
        link['__loaded'] = true;
        // Update link's import readyState.
        link.import && (link.import.readyState = 'complete');
        const eventType = link.import ? 'load' : 'error';
        link.dispatchEvent(newCustomEvent(eventType, {
          bubbles: false,
          cancelable: false,
          detail: undefined
        }));
      }
    }

    /**
     * @param {Array<MutationRecord>} mutations
     */
    handleMutations(mutations) {
      forEach(mutations, m => forEach(m.addedNodes, elem => {
        if (elem && elem.nodeType === Node.ELEMENT_NODE) {
          // NOTE: added scripts are not updating currentScript in IE.
          if (isImportLink(elem)) {
            this.loadImport( /** @type {!HTMLLinkElement} */ (elem));
          } else {
            this.loadImports( /** @type {!Element} */ (elem));
          }
        }
      }));
    }
  }

  /**
   * @param {!Node} node
   * @return {boolean}
   */
  const isImportLink = node => {
    return node.nodeType === Node.ELEMENT_NODE && node.localName === 'link' &&
      ( /** @type {!HTMLLinkElement} */ (node).rel === 'import');
  };

  /**
   * Waits for an element to finish loading. If already done loading, it will
   * mark the element accordingly.
   * @param {!(HTMLLinkElement|HTMLScriptElement|HTMLStyleElement)} element
   * @param {function()=} callback
   */
  const whenElementLoaded = (element, callback) => {
    if (element['__loaded']) {
      callback && callback();
    } else if ((element.localName === 'script' && !element.src) ||
      (element.localName === 'style' && !element.firstChild)) {
      // Inline scripts and empty styles don't trigger load/error events,
      // consider them already loaded.
      element['__loaded'] = true;
      callback && callback();
    } else {
      const onLoadingDone = event => {
        element.removeEventListener(event.type, onLoadingDone);
        element['__loaded'] = true;
        callback && callback();
      };
      element.addEventListener('load', onLoadingDone);
      // NOTE: We listen only for load events in IE/Edge, because in IE/Edge
      // <style> with @import will fire error events for each failing @import,
      // and finally will trigger the load event when all @import are
      // finished (even if all fail).
      if (!isIE || element.localName !== 'style') {
        element.addEventListener('error', onLoadingDone);
      }
    }
  };

  /**
   * Calls the callback when all imports in the document at call time
   * (or at least document ready) have loaded. Callback is called synchronously
   * if imports are already done loading.
   * @param {function()=} callback
   */
  const whenReady = callback => {
    // 1. ensure the document is in a ready state (has dom), then
    // 2. watch for loading of imports and call callback when done
    whenDocumentReady(() => whenImportsReady(() => callback && callback()));
  };

  /**
   * Invokes the callback when document is in ready state. Callback is called
   *  synchronously if document is already done loading.
   * @param {!function()} callback
   */
  const whenDocumentReady = callback => {
    const stateChanged = () => {
      // NOTE: Firefox can hit readystate interactive without document.body existing.
      // This is anti-spec, but we handle it here anyways by waiting for next change.
      if (document.readyState !== 'loading' && !!document.body) {
        document.removeEventListener('readystatechange', stateChanged);
        callback();
      }
    };
    document.addEventListener('readystatechange', stateChanged);
    stateChanged();
  };

  /**
   * Invokes the callback after all imports are loaded. Callback is called
   * synchronously if imports are already done loading.
   * @param {!function()} callback
   */
  const whenImportsReady = callback => {
    let imports = /** @type {!NodeList<!HTMLLinkElement>} */
      (QSA(document, rootImportSelector));
    let pending = imports.length;
    if (!pending) {
      callback();
      return;
    }
    forEach(imports, imp => whenElementLoaded(imp, () => {
      if (--pending === 0) {
        callback();
      }
    }));
  };

  /**
   * Returns the import document containing the element.
   * @param {!Node} element
   * @return {HTMLLinkElement|Document|undefined}
   */
  const importForElement = element => {
    if (useNative) {
      // Return only if not in the main doc!
      return element.ownerDocument !== document ? element.ownerDocument : null;
    }
    let doc = element['__importDoc'];
    if (!doc && element.parentNode) {
      doc = /** @type {!Element} */ (element.parentNode);
      if (typeof doc.closest === 'function') {
        // Element.closest returns the element itself if it matches the selector,
        // so we search the closest import starting from the parent.
        doc = doc.closest(importSelector);
      } else {
        // Walk up the parent tree until we find an import.
        while (!isImportLink(doc) && (doc = doc.parentNode)) {}
      }
      element['__importDoc'] = doc;
    }
    return doc;
  };

  let importer = null;
  /**
   * Ensures imports contained in the element are imported.
   * Use this to handle dynamic imports attached to body.
   * @param {!(HTMLDocument|Element)} doc
   */
  const loadImports = (doc) => {
    if (importer) {
      importer.loadImports(doc);
    }
  };

  const newCustomEvent = (type, params) => {
    if (typeof window.CustomEvent === 'function') {
      return new CustomEvent(type, params);
    }
    const event = /** @type {!CustomEvent} */ (document.createEvent('CustomEvent'));
    event.initCustomEvent(type, Boolean(params.bubbles), Boolean(params.cancelable), params.detail);
    return event;
  };

  if (useNative) {
    // Check for imports that might already be done loading by the time this
    // script is actually executed. Native imports are blocking, so the ones
    // available in the document by this time should already have failed
    // or have .import defined.
    const imps = /** @type {!NodeList<!HTMLLinkElement>} */
      (QSA(document, importSelector));
    forEach(imps, imp => {
      if (!imp.import || imp.import.readyState !== 'loading') {
        imp['__loaded'] = true;
      }
    });
    // Listen for load/error events to capture dynamically added scripts.
    /**
     * @type {!function(!Event)}
     */
    const onLoadingDone = event => {
      const elem = /** @type {!Element} */ (event.target);
      if (isImportLink(elem)) {
        elem['__loaded'] = true;
      }
    };
    document.addEventListener('load', onLoadingDone, true /* useCapture */ );
    document.addEventListener('error', onLoadingDone, true /* useCapture */ );
  } else {
    // Override baseURI so that imported elements' baseURI can be used seemlessly
    // on native or polyfilled html-imports.
    // NOTE: a <link rel=import> will have `link.baseURI === link.href`, as the link
    // itself is used as the `import` document.
    /** @type {Object|undefined} */
    const native_baseURI = Object.getOwnPropertyDescriptor(Node.prototype, 'baseURI');
    // NOTE: if not configurable (e.g. safari9), set it on the Element prototype. 
    const klass = !native_baseURI || native_baseURI.configurable ? Node : Element;
    Object.defineProperty(klass.prototype, 'baseURI', {
      get() {
        const ownerDoc = /** @type {HTMLLinkElement} */ (isImportLink(this) ? this : importForElement(this));
        if (ownerDoc) return ownerDoc.href;
        // Use native baseURI if possible.
        if (native_baseURI && native_baseURI.get) return native_baseURI.get.call(this);
        // Polyfill it if not available.
        const base = /** @type {HTMLBaseElement} */ (document.querySelector('base'));
        return (base || window.location).href;
      },
      configurable: true,
      enumerable: true
    });

    // Define 'import' read-only property.
    Object.defineProperty(HTMLLinkElement.prototype, 'import', {
      get() {
        return /** @type {HTMLLinkElement} */ (this)['__import'] || null;
      },
      configurable: true,
      enumerable: true
    });

    whenDocumentReady(() => {
      importer = new Importer();
    });
  }

  /**
    Add support for the `HTMLImportsLoaded` event and the `HTMLImports.whenReady`
    method. This api is necessary because unlike the native implementation,
    script elements do not force imports to resolve. Instead, users should wrap
    code in either an `HTMLImportsLoaded` handler or after load time in an
    `HTMLImports.whenReady(callback)` call.

    NOTE: This module also supports these apis under the native implementation.
    Therefore, if this file is loaded, the same code can be used under both
    the polyfill and native implementation.
   */
  whenReady(() => document.dispatchEvent(newCustomEvent('HTMLImportsLoaded', {
    cancelable: true,
    bubbles: true,
    detail: undefined
  })));

  // exports
  scope.useNative = useNative;
  scope.whenReady = whenReady;
  scope.importForElement = importForElement;
  scope.loadImports = loadImports;

})(window.HTMLImports = (window.HTMLImports || {}));

/**
@license
Copyright (c) 2016 The Polymer Project Authors. All rights reserved.
This code may only be used under the BSD style license found at http://polymer.github.io/LICENSE.txt
The complete set of authors may be found at http://polymer.github.io/AUTHORS.txt
The complete set of contributors may be found at http://polymer.github.io/CONTRIBUTORS.txt
Code distributed by Google as part of the polymer project is also
subject to an additional IP rights grant found at http://polymer.github.io/PATENTS.txt
*/

let settings = window['ShadyDOM'] || {};

settings.hasNativeShadowDOM = Boolean(Element.prototype.attachShadow && Node.prototype.getRootNode);

let desc = Object.getOwnPropertyDescriptor(Node.prototype, 'firstChild');

settings.hasDescriptors = Boolean(desc && desc.configurable && desc.get);
settings.inUse = settings['force'] || !settings.hasNativeShadowDOM;

function isTrackingLogicalChildNodes(node) {
  return (node.__shady && node.__shady.firstChild !== undefined);
}

function isShadyRoot(obj) {
  return Boolean(obj.__localName === 'ShadyRoot');
}

function ownerShadyRootForNode(node) {
  let root = node.getRootNode();
  if (isShadyRoot(root)) {
    return root;
  }
}

let p = Element.prototype;
let matches = p.matches || p.matchesSelector ||
  p.mozMatchesSelector || p.msMatchesSelector ||
  p.oMatchesSelector || p.webkitMatchesSelector;

function matchesSelector(element, selector) {
  return matches.call(element, selector);
}

function copyOwnProperty(name, source, target) {
  let pd = Object.getOwnPropertyDescriptor(source, name);
  if (pd) {
    Object.defineProperty(target, name, pd);
  }
}

function extend(target, source) {
  if (target && source) {
    let n$ = Object.getOwnPropertyNames(source);
    for (let i=0, n; (i<n$.length) && (n=n$[i]); i++) {
      copyOwnProperty(n, source, target);
    }
  }
  return target || source;
}

function extendAll(target, ...sources) {
  for (let i=0; i < sources.length; i++) {
    extend(target, sources[i]);
  }
  return target;
}

function mixin(target, source) {
  for (var i in source) {
    target[i] = source[i];
  }
  return target;
}

function patchPrototype(obj, mixin) {
  let proto = Object.getPrototypeOf(obj);
  if (!proto.hasOwnProperty('__patchProto')) {
    let patchProto = Object.create(proto);
    patchProto.__sourceProto = proto;
    extend(patchProto, mixin);
    proto['__patchProto'] = patchProto;
  }
  // old browsers don't have setPrototypeOf
  obj.__proto__ = proto['__patchProto'];
}


let twiddle = document.createTextNode('');
let content = 0;
let queue = [];
new MutationObserver(() => {
  while (queue.length) {
    // catch errors in user code...
    try {
      queue.shift()();
    } catch(e) {
      // enqueue another record and throw
      twiddle.textContent = content++;
      throw(e);
    }
  }
}).observe(twiddle, {characterData: true});

// use MutationObserver to get microtask async timing.
function microtask(callback) {
  queue.push(callback);
  twiddle.textContent = content++;
}

const hasDocumentContains = Boolean(document.contains);

function contains(container, node) {
  while (node) {
    if (node == container) {
      return true;
    }
    node = node.parentNode;
  }
  return false;
}

/**
@license
Copyright (c) 2016 The Polymer Project Authors. All rights reserved.
This code may only be used under the BSD style license found at http://polymer.github.io/LICENSE.txt
The complete set of authors may be found at http://polymer.github.io/AUTHORS.txt
The complete set of contributors may be found at http://polymer.github.io/CONTRIBUTORS.txt
Code distributed by Google as part of the polymer project is also
subject to an additional IP rights grant found at http://polymer.github.io/PATENTS.txt
*/

// render enqueuer/flusher
let flushList = [];
let scheduled;
function enqueue(callback) {
  if (!scheduled) {
    scheduled = true;
    microtask(flush);
  }
  flushList.push(callback);
}

function flush() {
  scheduled = false;
  let didFlush = Boolean(flushList.length);
  while (flushList.length) {
    flushList.shift()();
  }
  return didFlush;
}

flush['list'] = flushList;

/**
@license
Copyright (c) 2016 The Polymer Project Authors. All rights reserved.
This code may only be used under the BSD style license found at http://polymer.github.io/LICENSE.txt
The complete set of authors may be found at http://polymer.github.io/AUTHORS.txt
The complete set of contributors may be found at http://polymer.github.io/CONTRIBUTORS.txt
Code distributed by Google as part of the polymer project is also
subject to an additional IP rights grant found at http://polymer.github.io/PATENTS.txt
*/

class AsyncObserver {

  constructor() {
    this._scheduled = false;
    this.addedNodes = [];
    this.removedNodes = [];
    this.callbacks = new Set();
  }

  schedule() {
    if (!this._scheduled) {
      this._scheduled = true;
      microtask(() => {
        this.flush();
      });
    }
  }

  flush() {
    if (this._scheduled) {
      this._scheduled = false;
      let mutations = this.takeRecords();
      if (mutations.length) {
        this.callbacks.forEach(function(cb) {
          cb(mutations);
        });
      }
    }
  }

  takeRecords() {
    if (this.addedNodes.length || this.removedNodes.length) {
      let mutations = [{
        addedNodes: this.addedNodes,
        removedNodes: this.removedNodes
      }];
      this.addedNodes = [];
      this.removedNodes = [];
      return mutations;
    }
    return [];
  }

}

// TODO(sorvell): consider instead polyfilling MutationObserver
// directly so that users do not have to fork their code.
// Supporting the entire api may be challenging: e.g. filtering out
// removed nodes in the wrong scope and seeing non-distributing
// subtree child mutations.
let observeChildren = function(node, callback) {
  node.__shady = node.__shady || {};
  if (!node.__shady.observer) {
    node.__shady.observer = new AsyncObserver();
  }
  node.__shady.observer.callbacks.add(callback);
  let observer = node.__shady.observer;
  return {
    _callback: callback,
    _observer: observer,
    _node: node,
    takeRecords() {
      return observer.takeRecords()
    }
  };
};

let unobserveChildren = function(handle) {
  let observer = handle && handle._observer;
  if (observer) {
    observer.callbacks.delete(handle._callback);
    if (!observer.callbacks.size) {
      handle._node.__shady.observer = null;
    }
  }
};

function filterMutations(mutations, target) {
  /** @const {Node} */
  const targetRootNode = target.getRootNode();
  return mutations.map(function(mutation) {
    /** @const {boolean} */
    const mutationInScope = (targetRootNode === mutation.target.getRootNode());
    if (mutationInScope && mutation.addedNodes) {
      let nodes = Array.from(mutation.addedNodes).filter(function(n) {
        return (targetRootNode === n.getRootNode());
      });
      if (nodes.length) {
        mutation = Object.create(mutation);
        Object.defineProperty(mutation, 'addedNodes', {
          value: nodes,
          configurable: true
        });
        return mutation;
      }
    } else if (mutationInScope) {
      return mutation;
    }
  }).filter(function(m) { return m});
}

/**
@license
Copyright (c) 2016 The Polymer Project Authors. All rights reserved.
This code may only be used under the BSD style license found at http://polymer.github.io/LICENSE.txt
The complete set of authors may be found at http://polymer.github.io/AUTHORS.txt
The complete set of contributors may be found at http://polymer.github.io/CONTRIBUTORS.txt
Code distributed by Google as part of the polymer project is also
subject to an additional IP rights grant found at http://polymer.github.io/PATENTS.txt
*/

let appendChild = Element.prototype.appendChild;
let insertBefore = Element.prototype.insertBefore;
let removeChild = Element.prototype.removeChild;
let setAttribute = Element.prototype.setAttribute;
let removeAttribute = Element.prototype.removeAttribute;
let cloneNode = Element.prototype.cloneNode;
let importNode = Document.prototype.importNode;
let addEventListener = Element.prototype.addEventListener;
let removeEventListener = Element.prototype.removeEventListener;
let windowAddEventListener = Window.prototype.addEventListener;
let windowRemoveEventListener = Window.prototype.removeEventListener;
let dispatchEvent = Element.prototype.dispatchEvent;
let querySelector = Element.prototype.querySelector;
let querySelectorAll = Element.prototype.querySelectorAll;
let contains$1 = Node.prototype.contains || HTMLElement.prototype.contains;


var nativeMethods = Object.freeze({
	appendChild: appendChild,
	insertBefore: insertBefore,
	removeChild: removeChild,
	setAttribute: setAttribute,
	removeAttribute: removeAttribute,
	cloneNode: cloneNode,
	importNode: importNode,
	addEventListener: addEventListener,
	removeEventListener: removeEventListener,
	windowAddEventListener: windowAddEventListener,
	windowRemoveEventListener: windowRemoveEventListener,
	dispatchEvent: dispatchEvent,
	querySelector: querySelector,
	querySelectorAll: querySelectorAll,
	contains: contains$1
});

/**
@license
Copyright (c) 2016 The Polymer Project Authors. All rights reserved.
This code may only be used under the BSD style license found at http://polymer.github.io/LICENSE.txt
The complete set of authors may be found at http://polymer.github.io/AUTHORS.txt
The complete set of contributors may be found at http://polymer.github.io/CONTRIBUTORS.txt
Code distributed by Google as part of the polymer project is also
subject to an additional IP rights grant found at http://polymer.github.io/PATENTS.txt
*/

// Cribbed from ShadowDOM polyfill
// https://github.com/webcomponents/webcomponentsjs/blob/master/src/ShadowDOM/wrappers/HTMLElement.js#L28
/////////////////////////////////////////////////////////////////////////////
// innerHTML and outerHTML

// http://www.whatwg.org/specs/web-apps/current-work/multipage/the-end.html#escapingString
let escapeAttrRegExp = /[&\u00A0"]/g;
let escapeDataRegExp = /[&\u00A0<>]/g;

function escapeReplace(c) {
  switch (c) {
    case '&':
      return '&amp;';
    case '<':
      return '&lt;';
    case '>':
      return '&gt;';
    case '"':
      return '&quot;';
    case '\u00A0':
      return '&nbsp;';
  }
}

function escapeAttr(s) {
  return s.replace(escapeAttrRegExp, escapeReplace);
}

function escapeData(s) {
  return s.replace(escapeDataRegExp, escapeReplace);
}

function makeSet(arr) {
  let set = {};
  for (let i = 0; i < arr.length; i++) {
    set[arr[i]] = true;
  }
  return set;
}

// http://www.whatwg.org/specs/web-apps/current-work/#void-elements
let voidElements = makeSet([
  'area',
  'base',
  'br',
  'col',
  'command',
  'embed',
  'hr',
  'img',
  'input',
  'keygen',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr'
]);

let plaintextParents = makeSet([
  'style',
  'script',
  'xmp',
  'iframe',
  'noembed',
  'noframes',
  'plaintext',
  'noscript'
]);

/**
 * @param {Node} node
 * @param {Node} parentNode
 * @param {Function=} callback
 */
function getOuterHTML(node, parentNode, callback) {
  switch (node.nodeType) {
    case Node.ELEMENT_NODE: {
      let tagName = node.localName;
      let s = '<' + tagName;
      let attrs = node.attributes;
      for (let i = 0, attr; (attr = attrs[i]); i++) {
        s += ' ' + attr.name + '="' + escapeAttr(attr.value) + '"';
      }
      s += '>';
      if (voidElements[tagName]) {
        return s;
      }
      return s + getInnerHTML(node, callback) + '</' + tagName + '>';
    }
    case Node.TEXT_NODE: {
      let data = /** @type {Text} */ (node).data;
      if (parentNode && plaintextParents[parentNode.localName]) {
        return data;
      }
      return escapeData(data);
    }
    case Node.COMMENT_NODE: {
      return '<!--' + /** @type {Comment} */ (node).data + '-->';
    }
    default: {
      window.console.error(node);
      throw new Error('not implemented');
    }
  }
}

/**
 * @param {Node} node
 * @param {Function=} callback
 */
function getInnerHTML(node, callback) {
  if (node.localName === 'template') {
    node =  /** @type {HTMLTemplateElement} */ (node).content;
  }
  let s = '';
  let c$ = callback ? callback(node) : node.childNodes;
  for (let i=0, l=c$.length, child; (i<l) && (child=c$[i]); i++) {
    s += getOuterHTML(child, node, callback);
  }
  return s;
}

/**
@license
Copyright (c) 2016 The Polymer Project Authors. All rights reserved.
This code may only be used under the BSD style license found at http://polymer.github.io/LICENSE.txt
The complete set of authors may be found at http://polymer.github.io/AUTHORS.txt
The complete set of contributors may be found at http://polymer.github.io/CONTRIBUTORS.txt
Code distributed by Google as part of the polymer project is also
subject to an additional IP rights grant found at http://polymer.github.io/PATENTS.txt
*/

let nodeWalker = document.createTreeWalker(document, NodeFilter.SHOW_ALL,
  null, false);

let elementWalker = document.createTreeWalker(document, NodeFilter.SHOW_ELEMENT,
  null, false);

function parentNode(node) {
  nodeWalker.currentNode = node;
  return nodeWalker.parentNode();
}

function firstChild(node) {
  nodeWalker.currentNode = node;
  return nodeWalker.firstChild();
}

function lastChild(node) {
  nodeWalker.currentNode = node;
  return nodeWalker.lastChild();
}

function previousSibling(node) {
  nodeWalker.currentNode = node;
  return nodeWalker.previousSibling();
}

function nextSibling(node) {
  nodeWalker.currentNode = node;
  return nodeWalker.nextSibling();
}

function childNodes(node) {
  let nodes = [];
  nodeWalker.currentNode = node;
  let n = nodeWalker.firstChild();
  while (n) {
    nodes.push(n);
    n = nodeWalker.nextSibling();
  }
  return nodes;
}

function parentElement(node) {
  elementWalker.currentNode = node;
  return elementWalker.parentNode();
}

function firstElementChild(node) {
  elementWalker.currentNode = node;
  return elementWalker.firstChild();
}

function lastElementChild(node) {
  elementWalker.currentNode = node;
  return elementWalker.lastChild();
}

function previousElementSibling(node) {
  elementWalker.currentNode = node;
  return elementWalker.previousSibling();
}

function nextElementSibling(node) {
  elementWalker.currentNode = node;
  return elementWalker.nextSibling();
}

function children(node) {
  let nodes = [];
  elementWalker.currentNode = node;
  let n = elementWalker.firstChild();
  while (n) {
    nodes.push(n);
    n = elementWalker.nextSibling();
  }
  return nodes;
}

function innerHTML(node) {
  return getInnerHTML(node, (n) => childNodes(n));
}

function textContent(node) {
  switch (node.nodeType) {
    case Node.ELEMENT_NODE:
    case Node.DOCUMENT_FRAGMENT_NODE:
      let textWalker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT,
        null, false);
      let content = '', n;
      while ( (n = textWalker.nextNode()) ) {
        // TODO(sorvell): can't use textContent since we patch it on Node.prototype!
        // However, should probably patch it only on element.
        content += n.nodeValue;
      }
      return content;
    default:
      return node.nodeValue;
  }
}


var nativeTree = Object.freeze({
	parentNode: parentNode,
	firstChild: firstChild,
	lastChild: lastChild,
	previousSibling: previousSibling,
	nextSibling: nextSibling,
	childNodes: childNodes,
	parentElement: parentElement,
	firstElementChild: firstElementChild,
	lastElementChild: lastElementChild,
	previousElementSibling: previousElementSibling,
	nextElementSibling: nextElementSibling,
	children: children,
	innerHTML: innerHTML,
	textContent: textContent
});

/**
@license
Copyright (c) 2016 The Polymer Project Authors. All rights reserved.
This code may only be used under the BSD style license found at http://polymer.github.io/LICENSE.txt
The complete set of authors may be found at http://polymer.github.io/AUTHORS.txt
The complete set of contributors may be found at http://polymer.github.io/CONTRIBUTORS.txt
Code distributed by Google as part of the polymer project is also
subject to an additional IP rights grant found at http://polymer.github.io/PATENTS.txt
*/

function clearNode(node) {
  while (node.firstChild) {
    node.removeChild(node.firstChild);
  }
}

const nativeInnerHTMLDesc = /** @type {ObjectPropertyDescriptor} */(
  Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML') ||
  Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'innerHTML'));

const inertDoc = document.implementation.createHTMLDocument('inert');

const nativeActiveElementDescriptor =
  /** @type {ObjectPropertyDescriptor} */(
    Object.getOwnPropertyDescriptor(Document.prototype, 'activeElement')
  );
function getDocumentActiveElement() {
  if (nativeActiveElementDescriptor && nativeActiveElementDescriptor.get) {
    return nativeActiveElementDescriptor.get.call(document);
  } else if (!settings.hasDescriptors) {
    return document.activeElement;
  }
}

function activeElementForNode(node) {
  let active = getDocumentActiveElement();
  // In IE11, activeElement might be an empty object if the document is
  // contained in an iframe.
  // https://developer.microsoft.com/en-us/microsoft-edge/platform/issues/10998788/
  if (!active || !active.nodeType) {
    return null;
  }
  let isShadyRoot$$1 = !!(isShadyRoot(node));
  if (node !== document) {
    // If this node isn't a document or shady root, then it doesn't have
    // an active element.
    if (!isShadyRoot$$1) {
      return null;
    }
    // If this shady root's host is the active element or the active
    // element is not a descendant of the host (in the composed tree),
    // then it doesn't have an active element.
    if (node.host === active ||
        !contains$1.call(node.host, active)) {
      return null;
    }
  }
  // This node is either the document or a shady root of which the active
  // element is a (composed) descendant of its host; iterate upwards to
  // find the active element's most shallow host within it.
  let activeRoot = ownerShadyRootForNode(active);
  while (activeRoot && activeRoot !== node) {
    active = activeRoot.host;
    activeRoot = ownerShadyRootForNode(active);
  }
  if (node === document) {
    // This node is the document, so activeRoot should be null.
    return activeRoot ? null : active;
  } else {
    // This node is a non-document shady root, and it should be
    // activeRoot.
    return activeRoot === node ? active : null;
  }
}

let OutsideAccessors = {

  parentElement: {
    /** @this {Node} */
    get() {
      let l = this.__shady && this.__shady.parentNode;
      if (l && l.nodeType !== Node.ELEMENT_NODE) {
        l = null;
      }
      return l !== undefined ? l : parentElement(this);
    },
    configurable: true
  },

  parentNode: {
    /** @this {Node} */
    get() {
      let l = this.__shady && this.__shady.parentNode;
      return l !== undefined ? l : parentNode(this);
    },
    configurable: true
  },

  nextSibling: {
    /** @this {Node} */
    get() {
      let l = this.__shady && this.__shady.nextSibling;
      return l !== undefined ? l : nextSibling(this);
    },
    configurable: true
  },

  previousSibling: {
    /** @this {Node} */
    get() {
      let l = this.__shady && this.__shady.previousSibling;
      return l !== undefined ? l : previousSibling(this);
    },
    configurable: true
  },

  className: {
    /**
     * @this {HTMLElement}
     */
    get() {
      return this.getAttribute('class') || '';
    },
    /**
     * @this {HTMLElement}
     */
    set(value) {
      this.setAttribute('class', value);
    },
    configurable: true
  },

  // fragment, element, document
  nextElementSibling: {
    /**
     * @this {HTMLElement}
     */
    get() {
      if (this.__shady && this.__shady.nextSibling !== undefined) {
        let n = this.nextSibling;
        while (n && n.nodeType !== Node.ELEMENT_NODE) {
          n = n.nextSibling;
        }
        return n;
      } else {
        return nextElementSibling(this);
      }
    },
    configurable: true
  },

  previousElementSibling: {
    /**
     * @this {HTMLElement}
     */
    get() {
      if (this.__shady && this.__shady.previousSibling !== undefined) {
        let n = this.previousSibling;
        while (n && n.nodeType !== Node.ELEMENT_NODE) {
          n = n.previousSibling;
        }
        return n;
      } else {
        return previousElementSibling(this);
      }
    },
    configurable: true
  }

};

let InsideAccessors = {

  childNodes: {
    /**
     * @this {HTMLElement}
     */
    get() {
      let childNodes$$1;
      if (isTrackingLogicalChildNodes(this)) {
        if (!this.__shady.childNodes) {
          this.__shady.childNodes = [];
          for (let n=this.firstChild; n; n=n.nextSibling) {
            this.__shady.childNodes.push(n);
          }
        }
        childNodes$$1 = this.__shady.childNodes;
      } else {
        childNodes$$1 = childNodes(this);
      }
      childNodes$$1.item = function(index) {
        return childNodes$$1[index];
      };
      return childNodes$$1;
    },
    configurable: true
  },

  childElementCount: {
    /** @this {HTMLElement} */
    get() {
      return this.children.length;
    },
    configurable: true
  },

  firstChild: {
    /** @this {HTMLElement} */
    get() {
      let l = this.__shady && this.__shady.firstChild;
      return l !== undefined ? l : firstChild(this);
    },
    configurable: true
  },

  lastChild: {
  /** @this {HTMLElement} */
    get() {
      let l = this.__shady && this.__shady.lastChild;
      return l !== undefined ? l : lastChild(this);
    },
    configurable: true
  },

  textContent: {
    /**
     * @this {HTMLElement}
     */
    get() {
      if (isTrackingLogicalChildNodes(this)) {
        let tc = [];
        for (let i = 0, cn = this.childNodes, c; (c = cn[i]); i++) {
          if (c.nodeType !== Node.COMMENT_NODE) {
            tc.push(c.textContent);
          }
        }
        return tc.join('');
      } else {
        return textContent(this);
      }
    },
    /**
     * @this {HTMLElement}
     * @param {string} text
     */
    set(text) {
      switch (this.nodeType) {
        case Node.ELEMENT_NODE:
        case Node.DOCUMENT_FRAGMENT_NODE:
          clearNode(this);
          // Document fragments must have no childnodes if setting a blank string
          if (text.length > 0 || this.nodeType === Node.ELEMENT_NODE) {
            this.appendChild(document.createTextNode(text));
          }
          break;
        default:
          // TODO(sorvell): can't do this if patch nodeValue.
          this.nodeValue = text;
          break;
      }
    },
    configurable: true
  },

  // fragment, element, document
  firstElementChild: {
    /**
     * @this {HTMLElement}
     */
    get() {
      if (this.__shady && this.__shady.firstChild !== undefined) {
        let n = this.firstChild;
        while (n && n.nodeType !== Node.ELEMENT_NODE) {
          n = n.nextSibling;
        }
        return n;
      } else {
        return firstElementChild(this);
      }
    },
    configurable: true
  },

  lastElementChild: {
    /**
     * @this {HTMLElement}
     */
    get() {
      if (this.__shady && this.__shady.lastChild !== undefined) {
        let n = this.lastChild;
        while (n && n.nodeType !== Node.ELEMENT_NODE) {
          n = n.previousSibling;
        }
        return n;
      } else {
        return lastElementChild(this);
      }
    },
    configurable: true
  },

  children: {
    /**
     * @this {HTMLElement}
     */
    get() {
      let children$$1;
      if (isTrackingLogicalChildNodes(this)) {
        children$$1 = Array.prototype.filter.call(this.childNodes, function(n) {
          return (n.nodeType === Node.ELEMENT_NODE);
        });
      } else {
        children$$1 = children(this);
      }
      children$$1.item = function(index) {
        return children$$1[index];
      };
      return children$$1;
    },
    configurable: true
  },

  // element (HTMLElement on IE11)
  innerHTML: {
    /**
     * @this {HTMLElement}
     */
    get() {
      const content = this.localName === 'template' ?
        /** @type {HTMLTemplateElement} */(this).content : this;
      if (isTrackingLogicalChildNodes(this)) {
        return getInnerHTML(content);
      } else {
        return innerHTML(content);
      }
    },
    /**
     * @this {HTMLElement}
     */
    set(text) {
      const content = this.localName === 'template' ?
        /** @type {HTMLTemplateElement} */(this).content : this;
      clearNode(content);
      let containerName = this.localName;
      if (!containerName || containerName === 'template') {
        containerName = 'div';
      }
      const htmlContainer = inertDoc.createElement(containerName);
      if (nativeInnerHTMLDesc && nativeInnerHTMLDesc.set) {
        nativeInnerHTMLDesc.set.call(htmlContainer, text);
      } else {
        htmlContainer.innerHTML = text;
      }
      while (htmlContainer.firstChild) {
        content.appendChild(htmlContainer.firstChild);
      }
    },
    configurable: true
  }

};

// Note: Can be patched on element prototype on all browsers.
// Must be patched on instance on browsers that support native Shadow DOM
// but do not have builtin accessors (old Chrome).
let ShadowRootAccessor = {

  shadowRoot: {
    /**
     * @this {HTMLElement}
     */
    get() {
      return this.__shady && this.__shady.publicRoot || null;
    },
    configurable: true
  }
};

// Note: Can be patched on document prototype on browsers with builtin accessors.
// Must be patched separately on simulated ShadowRoot.
// Must be patched as `_activeElement` on browsers without builtin accessors.
let ActiveElementAccessor = {

  activeElement: {
    /**
     * @this {HTMLElement}
     */
    get() {
      return activeElementForNode(this);
    },
    /**
     * @this {HTMLElement}
     */
    set() {},
    configurable: true
  }

};

// patch a group of descriptors on an object only if it exists or if the `force`
// argument is true.
/**
 * @param {!Object} obj
 * @param {!Object} descriptors
 * @param {boolean=} force
 */
function patchAccessorGroup(obj, descriptors, force) {
  for (let p in descriptors) {
    let objDesc = Object.getOwnPropertyDescriptor(obj, p);
    if ((objDesc && objDesc.configurable) ||
      (!objDesc && force)) {
      Object.defineProperty(obj, p, descriptors[p]);
    } else if (force) {
      console.warn('Could not define', p, 'on', obj);
    }
  }
}

// patch dom accessors on proto where they exist
function patchAccessors(proto) {
  patchAccessorGroup(proto, OutsideAccessors);
  patchAccessorGroup(proto, InsideAccessors);
  patchAccessorGroup(proto, ActiveElementAccessor);
}

// ensure element descriptors (IE/Edge don't have em)
function patchShadowRootAccessors(proto) {
  patchAccessorGroup(proto, InsideAccessors, true);
  patchAccessorGroup(proto, ActiveElementAccessor, true);
}

// ensure an element has patched "outside" accessors; no-op when not needed
let patchOutsideElementAccessors = settings.hasDescriptors ?
  function() {} : function(element) {
    if (!(element.__shady && element.__shady.__outsideAccessors)) {
      element.__shady = element.__shady || {};
      element.__shady.__outsideAccessors = true;
      patchAccessorGroup(element, OutsideAccessors, true);
    }
  };

// ensure an element has patched "inside" accessors; no-op when not needed
let patchInsideElementAccessors = settings.hasDescriptors ?
  function() {} : function(element) {
    if (!(element.__shady && element.__shady.__insideAccessors)) {
      element.__shady = element.__shady || {};
      element.__shady.__insideAccessors = true;
      patchAccessorGroup(element, InsideAccessors, true);
      patchAccessorGroup(element, ShadowRootAccessor, true);
    }
  };

/**
@license
Copyright (c) 2016 The Polymer Project Authors. All rights reserved.
This code may only be used under the BSD style license found at http://polymer.github.io/LICENSE.txt
The complete set of authors may be found at http://polymer.github.io/AUTHORS.txt
The complete set of contributors may be found at http://polymer.github.io/CONTRIBUTORS.txt
Code distributed by Google as part of the polymer project is also
subject to an additional IP rights grant found at http://polymer.github.io/PATENTS.txt
*/

function recordInsertBefore(node, container, ref_node) {
  patchInsideElementAccessors(container);
  container.__shady = container.__shady || {};
  if (container.__shady.firstChild !== undefined) {
    container.__shady.childNodes = null;
  }
  // handle document fragments
  if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
    let c$ = node.childNodes;
    for (let i=0; i < c$.length; i++) {
      linkNode(c$[i], container, ref_node);
    }
    // cleanup logical dom in doc fragment.
    node.__shady = node.__shady || {};
    let resetTo = (node.__shady.firstChild !== undefined) ? null : undefined;
    node.__shady.firstChild = node.__shady.lastChild = resetTo;
    node.__shady.childNodes = resetTo;
  } else {
    linkNode(node, container, ref_node);
  }
}

function linkNode(node, container, ref_node) {
  patchOutsideElementAccessors(node);
  ref_node = ref_node || null;
  node.__shady = node.__shady || {};
  container.__shady = container.__shady || {};
  if (ref_node) {
    ref_node.__shady = ref_node.__shady || {};
  }
  // update ref_node.previousSibling <-> node
  node.__shady.previousSibling = ref_node ? ref_node.__shady.previousSibling :
    container.lastChild;
  let ps = node.__shady.previousSibling;
  if (ps && ps.__shady) {
    ps.__shady.nextSibling = node;
  }
  // update node <-> ref_node
  let ns = node.__shady.nextSibling = ref_node;
  if (ns && ns.__shady) {
    ns.__shady.previousSibling = node;
  }
  // update node <-> container
  node.__shady.parentNode = container;
  if (ref_node) {
    if (ref_node === container.__shady.firstChild) {
      container.__shady.firstChild = node;
    }
  } else {
    container.__shady.lastChild = node;
    if (!container.__shady.firstChild) {
      container.__shady.firstChild = node;
    }
  }
  // remove caching of childNodes
  container.__shady.childNodes = null;
}

function recordRemoveChild(node, container) {
  node.__shady = node.__shady || {};
  container.__shady = container.__shady || {};
  if (node === container.__shady.firstChild) {
    container.__shady.firstChild = node.__shady.nextSibling;
  }
  if (node === container.__shady.lastChild) {
    container.__shady.lastChild = node.__shady.previousSibling;
  }
  let p = node.__shady.previousSibling;
  let n = node.__shady.nextSibling;
  if (p) {
    p.__shady = p.__shady || {};
    p.__shady.nextSibling = n;
  }
  if (n) {
    n.__shady = n.__shady || {};
    n.__shady.previousSibling = p;
  }
  // When an element is removed, logical data is no longer tracked.
  // Explicitly set `undefined` here to indicate this. This is disginguished
  // from `null` which is set if info is null.
  node.__shady.parentNode = node.__shady.previousSibling =
    node.__shady.nextSibling = undefined;
  if (container.__shady.childNodes !== undefined) {
    // remove caching of childNodes
    container.__shady.childNodes = null;
  }
}

let recordChildNodes = function(node) {
  if (!node.__shady || node.__shady.firstChild === undefined) {
    node.__shady = node.__shady || {};
    node.__shady.firstChild = firstChild(node);
    node.__shady.lastChild = lastChild(node);
    patchInsideElementAccessors(node);
    let c$ = node.__shady.childNodes = childNodes(node);
    for (let i=0, n; (i<c$.length) && (n=c$[i]); i++) {
      n.__shady = n.__shady || {};
      n.__shady.parentNode = node;
      n.__shady.nextSibling = c$[i+1] || null;
      n.__shady.previousSibling = c$[i-1] || null;
      patchOutsideElementAccessors(n);
    }
  }
};

/**
@license
Copyright (c) 2016 The Polymer Project Authors. All rights reserved.
This code may only be used under the BSD style license found at http://polymer.github.io/LICENSE.txt
The complete set of authors may be found at http://polymer.github.io/AUTHORS.txt
The complete set of contributors may be found at http://polymer.github.io/CONTRIBUTORS.txt
Code distributed by Google as part of the polymer project is also
subject to an additional IP rights grant found at http://polymer.github.io/PATENTS.txt
*/

// Patched `insertBefore`. Note that all mutations that add nodes are routed
// here. When a <slot> is added or a node is added to a host with a shadowRoot
// with a slot, a standard dom `insert` call is aborted and `_asyncRender`
// is called on the relevant shadowRoot. In all other cases, a standard dom
// `insert` can be made, but the location and ref_node may need to be changed.
/**
 * @param {Node} parent
 * @param {Node} node
 * @param {Node=} ref_node
 */
function insertBefore$1(parent, node, ref_node) {
  if (node === parent) {
    throw Error(`Failed to execute 'appendChild' on 'Node': The new child element contains the parent.`);
  }
  if (ref_node) {
    let p = ref_node.__shady && ref_node.__shady.parentNode;
    if ((p !== undefined && p !== parent) ||
      (p === undefined && parentNode(ref_node) !== parent)) {
      throw Error(`Failed to execute 'insertBefore' on 'Node': The node ` +
       `before which the new node is to be inserted is not a child of this node.`);
    }
  }
  if (ref_node === node) {
    return node;
  }
  // remove from existing location
  if (node.parentNode) {
    // NOTE: avoid node.removeChild as this *can* trigger another patched
    // method (e.g. custom elements) and we want only the shady method to run.
    removeChild$1(node.parentNode, node);
  }
  // add to new parent
  let preventNativeInsert;
  let ownerRoot = ownerShadyRootForNode(parent);
  // if a slot is added, must render containing root.
  let slotsAdded = ownerRoot && findContainedSlots(node);
  if (slotsAdded) {
    ownerRoot._addSlots(slotsAdded);
  }
  if (ownerRoot && (parent.localName === 'slot' || slotsAdded)) {
    ownerRoot._asyncRender();
  }
  if (isTrackingLogicalChildNodes(parent)) {
    recordInsertBefore(node, parent, ref_node);
    // when inserting into a host with a shadowRoot with slot, use
    // `shadowRoot._asyncRender()` via `attach-shadow` module
    if (hasShadowRootWithSlot(parent)) {
      parent.__shady.root._asyncRender();
      preventNativeInsert = true;
    // when inserting into a host with shadowRoot with NO slot, do nothing
    // as the node should not be added to composed dome anywhere.
    } else if (parent.__shady.root) {
      preventNativeInsert = true;
    }
  }
  if (!preventNativeInsert) {
    // if adding to a shadyRoot, add to host instead
    let container = isShadyRoot(parent) ?
      /** @type {ShadowRoot} */(parent).host : parent;
    // if ref_node, get the ref_node that's actually in composed dom.
    if (ref_node) {
      ref_node = firstComposedNode(ref_node);
      insertBefore.call(container, node, ref_node);
    } else {
      appendChild.call(container, node);
    }
  }
  scheduleObserver(parent, node);
  return node;
}

function findContainedSlots(node) {
  if (!node['__noInsertionPoint']) {
    let slots;
    if (node.localName === 'slot') {
      slots = [node];
    } else if (node.querySelectorAll) {
      slots = node.querySelectorAll('slot');
    }
    if (slots && slots.length) {
      return slots;
    }
  }
}

/**
 * Patched `removeChild`. Note that all dom "removals" are routed here.
 * Removes the given `node` from the element's `children`.
 * This method also performs dom composition.
 * @param {Node} parent
 * @param {Node} node
*/
function removeChild$1(parent, node) {
  if (node.parentNode !== parent) {
    throw Error('The node to be removed is not a child of this node: ' +
      node);
  }
  let preventNativeRemove;
  let ownerRoot = ownerShadyRootForNode(node);
  let removingInsertionPoint;
  if (isTrackingLogicalChildNodes(parent)) {
    recordRemoveChild(node, parent);
    if (hasShadowRootWithSlot(parent)) {
      parent.__shady.root._asyncRender();
      preventNativeRemove = true;
    }
  }
  removeOwnerShadyRoot(node);
  // if removing slot, must render containing root
  if (ownerRoot) {
    let changeSlotContent = parent && parent.localName === 'slot';
    if (changeSlotContent) {
      preventNativeRemove = true;
    }
    removingInsertionPoint = ownerRoot._removeContainedSlots(node);
    if (removingInsertionPoint || changeSlotContent) {
      ownerRoot._asyncRender();
    }
  }
  if (!preventNativeRemove) {
    // if removing from a shadyRoot, remove form host instead
    let container = isShadyRoot(parent) ?
      /** @type {ShadowRoot} */(parent).host :
      parent;
    // not guaranteed to physically be in container; e.g.
    // (1) if parent has a shadyRoot, element may or may not at distributed
    // location (could be undistributed)
    // (2) if parent is a slot, element may not ben in composed dom
    if (!(parent.__shady.root || node.localName === 'slot') ||
      (container === parentNode(node))) {
      removeChild.call(container, node);
    }
  }
  scheduleObserver(parent, null, node);
  return node;
}

function removeOwnerShadyRoot(node) {
  // optimization: only reset the tree if node is actually in a root
  if (hasCachedOwnerRoot(node)) {
    let c$ = node.childNodes;
    for (let i=0, l=c$.length, n; (i<l) && (n=c$[i]); i++) {
      removeOwnerShadyRoot(n);
    }
  }
  if (node.__shady) {
    node.__shady.ownerShadyRoot = undefined;
  }
}

function hasCachedOwnerRoot(node) {
  return Boolean(node.__shady && node.__shady.ownerShadyRoot !== undefined);
}

/**
 * Finds the first flattened node that is composed in the node's parent.
 * If the given node is a slot, then the first flattened node is returned
 * if it exists, otherwise advance to the node's nextSibling.
 * @param {Node} node within which to find first composed node
 * @returns {Node} first composed node
 */
function firstComposedNode(node) {
  let composed = node;
  if (node && node.localName === 'slot') {
    let flattened = node.__shady && node.__shady.flattenedNodes;
    composed = flattened && flattened.length ? flattened[0] :
      firstComposedNode(node.nextSibling);
  }
  return composed;
}

function hasShadowRootWithSlot(node) {
  let root = node && node.__shady && node.__shady.root;
  return (root && root._hasInsertionPoint());
}

/**
 * Should be called whenever an attribute changes. If the `slot` attribute
 * changes, provokes rendering if necessary. If a `<slot>` element's `name`
 * attribute changes, updates the root's slot map and renders.
 * @param {Node} node
 * @param {string} name
 */
function distributeAttributeChange(node, name) {
  if (name === 'slot') {
    const parent = node.parentNode;
    if (hasShadowRootWithSlot(parent)) {
      parent.__shady.root._asyncRender();
    }
  } else if (node.localName === 'slot' && name === 'name') {
    let root = ownerShadyRootForNode(node);
    if (root) {
      root._updateSlotName(node);
      root._asyncRender();
    }
  }
}

/**
 * @param {Node} node
 * @param {Node=} addedNode
 * @param {Node=} removedNode
 */
function scheduleObserver(node, addedNode, removedNode) {
  let observer = node.__shady && node.__shady.observer;
  if (observer) {
    if (addedNode) {
      observer.addedNodes.push(addedNode);
    }
    if (removedNode) {
      observer.removedNodes.push(removedNode);
    }
    observer.schedule();
  }
}

/**
 * @param {Node} node
 * @param {Object=} options
 */
function getRootNode(node, options) { // eslint-disable-line no-unused-vars
  if (!node || !node.nodeType) {
    return;
  }
  node.__shady = node.__shady || {};
  let root = node.__shady.ownerShadyRoot;
  if (root === undefined) {
    if (isShadyRoot(node)) {
      root = node;
    } else {
      let parent = node.parentNode;
      root = parent ? getRootNode(parent) : node;
    }
    // memo-ize result for performance but only memo-ize
    // result if node is in the document. This avoids a problem where a root
    // can be cached while an element is inside a fragment.
    // If this happens and we cache the result, the value can become stale
    // because for perf we avoid processing the subtree of added fragments.
    if (contains$1.call(document.documentElement, node)) {
      node.__shady.ownerShadyRoot = root;
    }
  }
  return root;
}

// NOTE: `query` is used primarily for ShadyDOM's querySelector impl,
// but it's also generally useful to recurse through the element tree
// and is used by Polymer's styling system.
/**
 * @param {Node} node
 * @param {Function} matcher
 * @param {Function=} halter
 */
function query(node, matcher, halter) {
  let list = [];
  queryElements(node.childNodes, matcher,
    halter, list);
  return list;
}

function queryElements(elements, matcher, halter, list) {
  for (let i=0, l=elements.length, c; (i<l) && (c=elements[i]); i++) {
    if (c.nodeType === Node.ELEMENT_NODE &&
        queryElement(c, matcher, halter, list)) {
      return true;
    }
  }
}

function queryElement(node, matcher, halter, list) {
  let result = matcher(node);
  if (result) {
    list.push(node);
  }
  if (halter && halter(result)) {
    return result;
  }
  queryElements(node.childNodes, matcher,
    halter, list);
}

function renderRootNode(element) {
  var root = element.getRootNode();
  if (isShadyRoot(root)) {
    root._render();
  }
}

let scopingShim = null;

function setAttribute$1(node, attr, value) {
  if (!scopingShim) {
    scopingShim = window['ShadyCSS'] && window['ShadyCSS']['ScopingShim'];
  }
  if (scopingShim && attr === 'class') {
    scopingShim['setElementClass'](node, value);
  } else {
    setAttribute.call(node, attr, value);
    distributeAttributeChange(node, attr);
  }
}

function removeAttribute$1(node, attr) {
  removeAttribute.call(node, attr);
  distributeAttributeChange(node, attr);
}

function cloneNode$1(node, deep) {
  if (node.localName == 'template') {
    return cloneNode.call(node, deep);
  } else {
    let n = cloneNode.call(node, false);
    if (deep) {
      let c$ = node.childNodes;
      for (let i=0, nc; i < c$.length; i++) {
        nc = c$[i].cloneNode(true);
        n.appendChild(nc);
      }
    }
    return n;
  }
}

// note: Though not technically correct, we fast path `importNode`
// when called on a node not owned by the main document.
// This allows, for example, elements that cannot
// contain custom elements and are therefore not likely to contain shadowRoots
// to cloned natively. This is a fairly significant performance win.
function importNode$1(node, deep) {
  if (node.ownerDocument !== document) {
    return importNode.call(document, node, deep);
  }
  let n = importNode.call(document, node, false);
  if (deep) {
    let c$ = node.childNodes;
    for (let i=0, nc; i < c$.length; i++) {
      nc = importNode$1(c$[i], true);
      n.appendChild(nc);
    }
  }
  return n;
}

/**
@license
Copyright (c) 2016 The Polymer Project Authors. All rights reserved.
This code may only be used under the BSD style license found at http://polymer.github.io/LICENSE.txt
The complete set of authors may be found at http://polymer.github.io/AUTHORS.txt
The complete set of contributors may be found at http://polymer.github.io/CONTRIBUTORS.txt
Code distributed by Google as part of the polymer project is also
subject to an additional IP rights grant found at http://polymer.github.io/PATENTS.txt
*/

/*
Make this name unique so it is unlikely to conflict with properties on objects passed to `addEventListener`
https://github.com/webcomponents/shadydom/issues/173
*/
const eventWrappersName = `__eventWrappers${Date.now()}`;

// https://github.com/w3c/webcomponents/issues/513#issuecomment-224183937
let alwaysComposed = {
  'blur': true,
  'focus': true,
  'focusin': true,
  'focusout': true,
  'click': true,
  'dblclick': true,
  'mousedown': true,
  'mouseenter': true,
  'mouseleave': true,
  'mousemove': true,
  'mouseout': true,
  'mouseover': true,
  'mouseup': true,
  'wheel': true,
  'beforeinput': true,
  'input': true,
  'keydown': true,
  'keyup': true,
  'compositionstart': true,
  'compositionupdate': true,
  'compositionend': true,
  'touchstart': true,
  'touchend': true,
  'touchmove': true,
  'touchcancel': true,
  'pointerover': true,
  'pointerenter': true,
  'pointerdown': true,
  'pointermove': true,
  'pointerup': true,
  'pointercancel': true,
  'pointerout': true,
  'pointerleave': true,
  'gotpointercapture': true,
  'lostpointercapture': true,
  'dragstart': true,
  'drag': true,
  'dragenter': true,
  'dragleave': true,
  'dragover': true,
  'drop': true,
  'dragend': true,
  'DOMActivate': true,
  'DOMFocusIn': true,
  'DOMFocusOut': true,
  'keypress': true
};

function pathComposer(startNode, composed) {
  let composedPath = [];
  let current = startNode;
  let startRoot = startNode === window ? window : startNode.getRootNode();
  while (current) {
    composedPath.push(current);
    if (current.assignedSlot) {
      current = current.assignedSlot;
    } else if (current.nodeType === Node.DOCUMENT_FRAGMENT_NODE && current.host && (composed || current !== startRoot)) {
      current = current.host;
    } else {
      current = current.parentNode;
    }
  }
  // event composedPath includes window when startNode's ownerRoot is document
  if (composedPath[composedPath.length - 1] === document) {
    composedPath.push(window);
  }
  return composedPath;
}

function retarget(refNode, path) {
  if (!isShadyRoot) {
    return refNode;
  }
  // If ANCESTOR's root is not a shadow root or ANCESTOR's root is BASE's
  // shadow-including inclusive ancestor, return ANCESTOR.
  let refNodePath = pathComposer(refNode, true);
  let p$ = path;
  for (let i=0, ancestor, lastRoot, root, rootIdx; i < p$.length; i++) {
    ancestor = p$[i];
    root = ancestor === window ? window : ancestor.getRootNode();
    if (root !== lastRoot) {
      rootIdx = refNodePath.indexOf(root);
      lastRoot = root;
    }
    if (!isShadyRoot(root) || rootIdx > -1) {
      return ancestor;
    }
  }
}

let eventMixin = {

  /**
   * @this {Event}
   */
  get composed() {
    // isTrusted may not exist in this browser, so just check if isTrusted is explicitly false
    if (this.isTrusted !== false && this.__composed === undefined) {
      this.__composed = alwaysComposed[this.type];
    }
    return this.__composed || false;
  },

  /**
   * @this {Event}
   */
  composedPath() {
    if (!this.__composedPath) {
      this.__composedPath = pathComposer(this['__target'], this.composed);
    }
    return this.__composedPath;
  },

  /**
   * @this {Event}
   */
  get target() {
    return retarget(this.currentTarget, this.composedPath());
  },

  // http://w3c.github.io/webcomponents/spec/shadow/#event-relatedtarget-retargeting
  /**
   * @this {Event}
   */
  get relatedTarget() {
    if (!this.__relatedTarget) {
      return null;
    }
    if (!this.__relatedTargetComposedPath) {
      this.__relatedTargetComposedPath = pathComposer(this.__relatedTarget, true);
    }
    // find the deepest node in relatedTarget composed path that is in the same root with the currentTarget
    return retarget(this.currentTarget, this.__relatedTargetComposedPath);
  },
  /**
   * @this {Event}
   */
  stopPropagation() {
    Event.prototype.stopPropagation.call(this);
    this.__propagationStopped = true;
  },
  /**
   * @this {Event}
   */
  stopImmediatePropagation() {
    Event.prototype.stopImmediatePropagation.call(this);
    this.__immediatePropagationStopped = true;
    this.__propagationStopped = true;
  }

};

function mixinComposedFlag(Base) {
  // NOTE: avoiding use of `class` here so that transpiled output does not
  // try to do `Base.call` with a dom construtor.
  let klazz = function(type, options) {
    let event = new Base(type, options);
    event.__composed = options && Boolean(options['composed']);
    return event;
  };
  // put constructor properties on subclass
  mixin(klazz, Base);
  klazz.prototype = Base.prototype;
  return klazz;
}

let nonBubblingEventsToRetarget = {
  'focus': true,
  'blur': true
};


/**
 * Check if the event has been retargeted by comparing original `target`, and calculated `target`
 * @param {Event} event
 * @return {boolean} True if the original target and calculated target are the same
 */
function hasRetargeted(event) {
  return event['__target'] !== event.target || event.__relatedTarget !== event.relatedTarget;
}

/**
 *
 * @param {Event} event
 * @param {Node} node
 * @param {string} phase
 */
function fireHandlers(event, node, phase) {
  let hs = node.__handlers && node.__handlers[event.type] &&
    node.__handlers[event.type][phase];
  if (hs) {
    for (let i = 0, fn; (fn = hs[i]); i++) {
      if (hasRetargeted(event) && event.target === event.relatedTarget) {
        return;
      }
      fn.call(node, event);
      if (event.__immediatePropagationStopped) {
        return;
      }
    }
  }
}

function retargetNonBubblingEvent(e) {
  let path = e.composedPath();
  let node;
  // override `currentTarget` to let patched `target` calculate correctly
  Object.defineProperty(e, 'currentTarget', {
    get: function() {
      return node;
    },
    configurable: true
  });
  for (let i = path.length - 1; i >= 0; i--) {
    node = path[i];
    // capture phase fires all capture handlers
    fireHandlers(e, node, 'capture');
    if (e.__propagationStopped) {
      return;
    }
  }

  // set the event phase to `AT_TARGET` as in spec
  Object.defineProperty(e, 'eventPhase', {get() { return Event.AT_TARGET }});

  // the event only needs to be fired when owner roots change when iterating the event path
  // keep track of the last seen owner root
  let lastFiredRoot;
  for (let i = 0; i < path.length; i++) {
    node = path[i];
    const root = node.__shady && node.__shady.root;
    if (i === 0 || (root && root === lastFiredRoot)) {
      fireHandlers(e, node, 'bubble');
      // don't bother with window, it doesn't have `getRootNode` and will be last in the path anyway
      if (node !== window) {
        lastFiredRoot = node.getRootNode();
      }
      if (e.__propagationStopped) {
        return;
      }
    }
  }
}

function listenerSettingsEqual(savedListener, node, type, capture, once, passive) {
  let {
    node: savedNode,
    type: savedType,
    capture: savedCapture,
    once: savedOnce,
    passive: savedPassive
  } = savedListener;
  return node === savedNode &&
    type === savedType &&
    capture === savedCapture &&
    once === savedOnce &&
    passive === savedPassive;
}

function findListener(wrappers, node, type, capture, once, passive) {
  for (let i = 0; i < wrappers.length; i++) {
    if (listenerSettingsEqual(wrappers[i], node, type, capture, once, passive)) {
      return i;
    }
  }
  return -1;
}

/**
 * Firefox can throw on accessing eventWrappers inside of `removeEventListener` during a selenium run
 * Try/Catch accessing eventWrappers to work around
 * https://bugzilla.mozilla.org/show_bug.cgi?id=1353074
 */
function getEventWrappers(eventLike) {
  let wrappers = null;
  try {
    wrappers = eventLike[eventWrappersName];
  } catch (e) {} // eslint-disable-line no-empty
  return wrappers;
}

/**
 * @this {Event}
 */
function addEventListener$1(type, fnOrObj, optionsOrCapture) {
  if (!fnOrObj) {
    return;
  }

  const handlerType = typeof fnOrObj;

  // bail if `fnOrObj` is not a function, not an object
  if (handlerType !== 'function' && handlerType !== 'object') {
    return;
  }

  // bail if `fnOrObj` is an object without a `handleEvent` method
  if (handlerType === 'object' && (!fnOrObj.handleEvent || typeof fnOrObj.handleEvent !== 'function')) {
    return;
  }

  // The callback `fn` might be used for multiple nodes/events. Since we generate
  // a wrapper function, we need to keep track of it when we remove the listener.
  // It's more efficient to store the node/type/options information as Array in
  // `fn` itself rather than the node (we assume that the same callback is used
  // for few nodes at most, whereas a node will likely have many event listeners).
  // NOTE(valdrin) invoking external functions is costly, inline has better perf.
  let capture, once, passive;
  if (optionsOrCapture && typeof optionsOrCapture === 'object') {
    capture = Boolean(optionsOrCapture.capture);
    once = Boolean(optionsOrCapture.once);
    passive = Boolean(optionsOrCapture.passive);
  } else {
    capture = Boolean(optionsOrCapture);
    once = false;
    passive = false;
  }
  // hack to let ShadyRoots have event listeners
  // event listener will be on host, but `currentTarget`
  // will be set to shadyroot for event listener
  let target = (optionsOrCapture && optionsOrCapture.__shadyTarget) || this;

  let wrappers = fnOrObj[eventWrappersName];
  if (wrappers) {
    // Stop if the wrapper function has already been created.
    if (findListener(wrappers, target, type, capture, once, passive) > -1) {
      return;
    }
  } else {
    fnOrObj[eventWrappersName] = [];
  }

  /**
   * @this {HTMLElement}
   * @param {Event} e
   */
  const wrapperFn = function(e) {
    // Support `once` option.
    if (once) {
      this.removeEventListener(type, fnOrObj, optionsOrCapture);
    }
    if (!e['__target']) {
      patchEvent(e);
    }
    let lastCurrentTargetDesc;
    if (target !== this) {
      // replace `currentTarget` to make `target` and `relatedTarget` correct for inside the shadowroot
      lastCurrentTargetDesc = Object.getOwnPropertyDescriptor(e, 'currentTarget');
      Object.defineProperty(e, 'currentTarget', {get() { return target }, configurable: true});
    }
    // There are two critera that should stop events from firing on this node
    // 1. the event is not composed and the current node is not in the same root as the target
    // 2. when bubbling, if after retargeting, relatedTarget and target point to the same node
    if (e.composed || e.composedPath().indexOf(target) > -1) {
      if (hasRetargeted(e) && e.target === e.relatedTarget) {
        if (e.eventPhase === Event.BUBBLING_PHASE) {
          e.stopImmediatePropagation();
        }
        return;
      }
      // prevent non-bubbling events from triggering bubbling handlers on shadowroot, but only if not in capture phase
      if (e.eventPhase !== Event.CAPTURING_PHASE && !e.bubbles && e.target !== target && !(target instanceof Window)) {
        return;
      }
      let ret = handlerType === 'function' ?
        fnOrObj.call(target, e) :
        (fnOrObj.handleEvent && fnOrObj.handleEvent(e));
      if (target !== this) {
        // replace the "correct" `currentTarget`
        if (lastCurrentTargetDesc) {
          Object.defineProperty(e, 'currentTarget', lastCurrentTargetDesc);
          lastCurrentTargetDesc = null;
        } else {
          delete e['currentTarget'];
        }
      }
      return ret;
    }
  };
  // Store the wrapper information.
  fnOrObj[eventWrappersName].push({
    node: this,
    type: type,
    capture: capture,
    once: once,
    passive: passive,
    wrapperFn: wrapperFn
  });

  if (nonBubblingEventsToRetarget[type]) {
    this.__handlers = this.__handlers || {};
    this.__handlers[type] = this.__handlers[type] ||
      {'capture': [], 'bubble': []};
    this.__handlers[type][capture ? 'capture' : 'bubble'].push(wrapperFn);
  } else {
    let ael = this instanceof Window ? windowAddEventListener :
      addEventListener;
    ael.call(this, type, wrapperFn, optionsOrCapture);
  }
}

/**
 * @this {Event}
 */
function removeEventListener$1(type, fnOrObj, optionsOrCapture) {
  if (!fnOrObj) {
    return;
  }

  // NOTE(valdrin) invoking external functions is costly, inline has better perf.
  let capture, once, passive;
  if (optionsOrCapture && typeof optionsOrCapture === 'object') {
    capture = Boolean(optionsOrCapture.capture);
    once = Boolean(optionsOrCapture.once);
    passive = Boolean(optionsOrCapture.passive);
  } else {
    capture = Boolean(optionsOrCapture);
    once = false;
    passive = false;
  }
  let target = (optionsOrCapture && optionsOrCapture.__shadyTarget) || this;
  // Search the wrapped function.
  let wrapperFn = undefined;
  let wrappers = getEventWrappers(fnOrObj);
  if (wrappers) {
    let idx = findListener(wrappers, target, type, capture, once, passive);
    if (idx > -1) {
      wrapperFn = wrappers.splice(idx, 1)[0].wrapperFn;
      // Cleanup.
      if (!wrappers.length) {
        fnOrObj[eventWrappersName] = undefined;
      }
    }
  }
  let rel = this instanceof Window ? windowRemoveEventListener :
    removeEventListener;
  rel.call(this, type, wrapperFn || fnOrObj, optionsOrCapture);
  if (wrapperFn && nonBubblingEventsToRetarget[type] &&
      this.__handlers && this.__handlers[type]) {
    const arr = this.__handlers[type][capture ? 'capture' : 'bubble'];
    const idx = arr.indexOf(wrapperFn);
    if (idx > -1) {
      arr.splice(idx, 1);
    }
  }
}

function activateFocusEventOverrides() {
  for (let ev in nonBubblingEventsToRetarget) {
    window.addEventListener(ev, function(e) {
      if (!e['__target']) {
        patchEvent(e);
        retargetNonBubblingEvent(e);
      }
    }, true);
  }
}

function patchEvent(event) {
  event['__target'] = event.target;
  event.__relatedTarget = event.relatedTarget;
  // patch event prototype if we can
  if (settings.hasDescriptors) {
    patchPrototype(event, eventMixin);
  // and fallback to patching instance
  } else {
    extend(event, eventMixin);
  }
}

let PatchedEvent = mixinComposedFlag(window.Event);
let PatchedCustomEvent = mixinComposedFlag(window.CustomEvent);
let PatchedMouseEvent = mixinComposedFlag(window.MouseEvent);

function patchEvents() {
  window.Event = PatchedEvent;
  window.CustomEvent = PatchedCustomEvent;
  window.MouseEvent = PatchedMouseEvent;
  activateFocusEventOverrides();
}

/**
@license
Copyright (c) 2016 The Polymer Project Authors. All rights reserved.
This code may only be used under the BSD style license found at http://polymer.github.io/LICENSE.txt
The complete set of authors may be found at http://polymer.github.io/AUTHORS.txt
The complete set of contributors may be found at http://polymer.github.io/CONTRIBUTORS.txt
Code distributed by Google as part of the polymer project is also
subject to an additional IP rights grant found at http://polymer.github.io/PATENTS.txt
*/

function newSplice(index, removed, addedCount) {
  return {
    index: index,
    removed: removed,
    addedCount: addedCount
  };
}

const EDIT_LEAVE = 0;
const EDIT_UPDATE = 1;
const EDIT_ADD = 2;
const EDIT_DELETE = 3;

// Note: This function is *based* on the computation of the Levenshtein
// "edit" distance. The one change is that "updates" are treated as two
// edits - not one. With Array splices, an update is really a delete
// followed by an add. By retaining this, we optimize for "keeping" the
// maximum array items in the original array. For example:
//
//   'xxxx123' -> '123yyyy'
//
// With 1-edit updates, the shortest path would be just to update all seven
// characters. With 2-edit updates, we delete 4, leave 3, and add 4. This
// leaves the substring '123' intact.
function calcEditDistances(current, currentStart, currentEnd,
                            old, oldStart, oldEnd) {
  // "Deletion" columns
  let rowCount = oldEnd - oldStart + 1;
  let columnCount = currentEnd - currentStart + 1;
  let distances = new Array(rowCount);

  // "Addition" rows. Initialize null column.
  for (let i = 0; i < rowCount; i++) {
    distances[i] = new Array(columnCount);
    distances[i][0] = i;
  }

  // Initialize null row
  for (let j = 0; j < columnCount; j++)
    distances[0][j] = j;

  for (let i = 1; i < rowCount; i++) {
    for (let j = 1; j < columnCount; j++) {
      if (equals(current[currentStart + j - 1], old[oldStart + i - 1]))
        distances[i][j] = distances[i - 1][j - 1];
      else {
        let north = distances[i - 1][j] + 1;
        let west = distances[i][j - 1] + 1;
        distances[i][j] = north < west ? north : west;
      }
    }
  }

  return distances;
}

// This starts at the final weight, and walks "backward" by finding
// the minimum previous weight recursively until the origin of the weight
// matrix.
function spliceOperationsFromEditDistances(distances) {
  let i = distances.length - 1;
  let j = distances[0].length - 1;
  let current = distances[i][j];
  let edits = [];
  while (i > 0 || j > 0) {
    if (i == 0) {
      edits.push(EDIT_ADD);
      j--;
      continue;
    }
    if (j == 0) {
      edits.push(EDIT_DELETE);
      i--;
      continue;
    }
    let northWest = distances[i - 1][j - 1];
    let west = distances[i - 1][j];
    let north = distances[i][j - 1];

    let min;
    if (west < north)
      min = west < northWest ? west : northWest;
    else
      min = north < northWest ? north : northWest;

    if (min == northWest) {
      if (northWest == current) {
        edits.push(EDIT_LEAVE);
      } else {
        edits.push(EDIT_UPDATE);
        current = northWest;
      }
      i--;
      j--;
    } else if (min == west) {
      edits.push(EDIT_DELETE);
      i--;
      current = west;
    } else {
      edits.push(EDIT_ADD);
      j--;
      current = north;
    }
  }

  edits.reverse();
  return edits;
}

/**
 * Splice Projection functions:
 *
 * A splice map is a representation of how a previous array of items
 * was transformed into a new array of items. Conceptually it is a list of
 * tuples of
 *
 *   <index, removed, addedCount>
 *
 * which are kept in ascending index order of. The tuple represents that at
 * the |index|, |removed| sequence of items were removed, and counting forward
 * from |index|, |addedCount| items were added.
 */

/**
 * Lacking individual splice mutation information, the minimal set of
 * splices can be synthesized given the previous state and final state of an
 * array. The basic approach is to calculate the edit distance matrix and
 * choose the shortest path through it.
 *
 * Complexity: O(l * p)
 *   l: The length of the current array
 *   p: The length of the old array
 */
function calcSplices(current, currentStart, currentEnd,
                      old, oldStart, oldEnd) {
  let prefixCount = 0;
  let suffixCount = 0;
  let splice;

  let minLength = Math.min(currentEnd - currentStart, oldEnd - oldStart);
  if (currentStart == 0 && oldStart == 0)
    prefixCount = sharedPrefix(current, old, minLength);

  if (currentEnd == current.length && oldEnd == old.length)
    suffixCount = sharedSuffix(current, old, minLength - prefixCount);

  currentStart += prefixCount;
  oldStart += prefixCount;
  currentEnd -= suffixCount;
  oldEnd -= suffixCount;

  if (currentEnd - currentStart == 0 && oldEnd - oldStart == 0)
    return [];

  if (currentStart == currentEnd) {
    splice = newSplice(currentStart, [], 0);
    while (oldStart < oldEnd)
      splice.removed.push(old[oldStart++]);

    return [ splice ];
  } else if (oldStart == oldEnd)
    return [ newSplice(currentStart, [], currentEnd - currentStart) ];

  let ops = spliceOperationsFromEditDistances(
      calcEditDistances(current, currentStart, currentEnd,
                             old, oldStart, oldEnd));

  splice = undefined;
  let splices = [];
  let index = currentStart;
  let oldIndex = oldStart;
  for (let i = 0; i < ops.length; i++) {
    switch(ops[i]) {
      case EDIT_LEAVE:
        if (splice) {
          splices.push(splice);
          splice = undefined;
        }

        index++;
        oldIndex++;
        break;
      case EDIT_UPDATE:
        if (!splice)
          splice = newSplice(index, [], 0);

        splice.addedCount++;
        index++;

        splice.removed.push(old[oldIndex]);
        oldIndex++;
        break;
      case EDIT_ADD:
        if (!splice)
          splice = newSplice(index, [], 0);

        splice.addedCount++;
        index++;
        break;
      case EDIT_DELETE:
        if (!splice)
          splice = newSplice(index, [], 0);

        splice.removed.push(old[oldIndex]);
        oldIndex++;
        break;
    }
  }

  if (splice) {
    splices.push(splice);
  }
  return splices;
}

function sharedPrefix(current, old, searchLength) {
  for (let i = 0; i < searchLength; i++)
    if (!equals(current[i], old[i]))
      return i;
  return searchLength;
}

function sharedSuffix(current, old, searchLength) {
  let index1 = current.length;
  let index2 = old.length;
  let count = 0;
  while (count < searchLength && equals(current[--index1], old[--index2]))
    count++;

  return count;
}

function equals(currentValue, previousValue) {
  return currentValue === previousValue;
}

function calculateSplices(current, previous) {
  return calcSplices(current, 0, current.length, previous, 0,
                          previous.length);
}

/**
@license
Copyright (c) 2016 The Polymer Project Authors. All rights reserved.
This code may only be used under the BSD style license found at http://polymer.github.io/LICENSE.txt
The complete set of authors may be found at http://polymer.github.io/AUTHORS.txt
The complete set of contributors may be found at http://polymer.github.io/CONTRIBUTORS.txt
Code distributed by Google as part of the polymer project is also
subject to an additional IP rights grant found at http://polymer.github.io/PATENTS.txt
*/

// Do not export this object. It must be passed as the first argument to the
// ShadyRoot constructor in `attachShadow` to prevent the constructor from
// throwing. This prevents the user from being able to manually construct a
// ShadyRoot (i.e. `new ShadowRoot()`).
const ShadyRootConstructionToken = {};

const CATCHALL_NAME = '__catchall';

/**
 * @constructor
 * @extends {ShadowRoot}
 */
let ShadyRoot = function(token, host, options) {
  if (token !== ShadyRootConstructionToken) {
    throw new TypeError('Illegal constructor');
  }
  // NOTE: this strange construction is necessary because
  // DocumentFragment cannot be subclassed on older browsers.
  let shadowRoot = document.createDocumentFragment();
  shadowRoot.__proto__ = ShadyRoot.prototype;
  /** @type {ShadyRoot} */ (shadowRoot)._init(host, options);
  return shadowRoot;
};

ShadyRoot.prototype = Object.create(DocumentFragment.prototype);

ShadyRoot.prototype._init = function(host, options) {
  // NOTE: set a fake local name so this element can be
  // distinguished from a DocumentFragment when patching.
  // FF doesn't allow this to be `localName`
  this.__localName = 'ShadyRoot';
  // logical dom setup
  recordChildNodes(host);
  recordChildNodes(this);
  // root <=> host
  this.host = host;
  this._mode = options && options.mode;
  host.__shady = host.__shady || {};
  host.__shady.root = this;
  host.__shady.publicRoot = this._mode !== 'closed' ? this : null;
  // state flags
  this._renderPending = false;
  this._hasRendered = false;
  this._slotList = [];
  this._slotMap = {};
  this.__pendingSlots = [];
  // fast path initial render: remove existing physical dom.
  let c$ = childNodes(host);
  for (let i=0, l=c$.length; i < l; i++) {
    removeChild.call(host, c$[i]);
  }
};

// async render
ShadyRoot.prototype._asyncRender = function() {
  if (!this._renderPending) {
    this._renderPending = true;
    enqueue(() => this._render());
  }
};

// returns the oldest renderPending ancestor root.
ShadyRoot.prototype._getRenderRoot = function() {
  let renderRoot;
  let root = this;
  while (root) {
    if (root._renderPending) {
      renderRoot = root;
    }
    root = root._rendererForHost();
  }
  return renderRoot;
};

// Returns the shadyRoot `this.host` if `this.host`
// has children that require distribution.
ShadyRoot.prototype._rendererForHost = function() {
  let root = this.host.getRootNode();
  if (isShadyRoot(root)) {
    let c$ = this.host.childNodes;
    for (let i=0, c; i < c$.length; i++) {
      c = c$[i];
      if (this._isInsertionPoint(c)) {
        return root;
      }
    }
  }
};

ShadyRoot.prototype._render = function() {
  const root = this._getRenderRoot();
  if (root) {
    root['_renderRoot']();
  }
};

// NOTE: avoid renaming to ease testability.
ShadyRoot.prototype['_renderRoot'] = function() {
  this._renderPending = false;
  this._distribute();
  this._compose();
  this._hasRendered = true;
};

ShadyRoot.prototype._distribute = function() {
  this._validateSlots();
  // capture # of previously assigned nodes to help determine if dirty.
  for (let i=0, slot; i < this._slotList.length; i++) {
    slot = this._slotList[i];
    this._clearSlotAssignedNodes(slot);
  }
  // distribute host children.
  for (let n=this.host.firstChild; n; n=n.nextSibling) {
    this._distributeNodeToSlot(n);
  }
  // fallback content, slotchange, and dirty roots
  for (let i=0, slot; i < this._slotList.length; i++) {
    slot = this._slotList[i];
    // distribute fallback content
    if (!slot.__shady.assignedNodes.length) {
      for (let n=slot.firstChild; n; n=n.nextSibling) {
        this._distributeNodeToSlot(n, slot);
      }
    }
    const slotParent = slot.parentNode;
    const slotParentRoot = slotParent.__shady && slotParent.__shady.root;
    if (slotParentRoot && slotParentRoot._hasInsertionPoint()) {
      slotParentRoot['_renderRoot']();
    }
    this._addAssignedToFlattenedNodes(slot.__shady.flattenedNodes,
      slot.__shady.assignedNodes);
    let prevAssignedNodes = slot.__shady._previouslyAssignedNodes;
    if (prevAssignedNodes) {
      for (let i=0; i < prevAssignedNodes.length; i++) {
        prevAssignedNodes[i].__shady._prevAssignedSlot = null;
      }
      slot.__shady._previouslyAssignedNodes = null;
      // dirty if previously less assigned nodes than previously assigned.
      if (prevAssignedNodes.length > slot.__shady.assignedNodes.length) {
        slot.__shady.dirty = true;
      }
    }
    /* Note: A slot is marked dirty whenever a node is newly assigned to it
    or a node is assigned to a different slot (done in `_distributeNodeToSlot`)
    or if the number of nodes assigned to the slot has decreased (done above);
     */
    if (slot.__shady.dirty) {
      slot.__shady.dirty = false;
      this._fireSlotChange(slot);
    }
  }
};

/**
 * Distributes given `node` to the appropriate slot based on its `slot`
 * attribute. If `forcedSlot` is given, then the node is distributed to the
 * `forcedSlot`.
 * Note: slot to which the node is assigned will be marked dirty for firing
 * `slotchange`.
 * @param {Node} node
 * @param {Node=} forcedSlot
 *
 */
ShadyRoot.prototype._distributeNodeToSlot = function(node, forcedSlot) {
  node.__shady = node.__shady || {};
  let oldSlot = node.__shady._prevAssignedSlot;
  node.__shady._prevAssignedSlot = null;
  let slot = forcedSlot;
  if (!slot) {
    let name = node.slot || CATCHALL_NAME;
    const list = this._slotMap[name];
    slot = list && list[0];
  }
  if (slot) {
    slot.__shady.assignedNodes.push(node);
    node.__shady.assignedSlot = slot;
  } else {
    node.__shady.assignedSlot = undefined;
  }
  if (oldSlot !== node.__shady.assignedSlot) {
    if (node.__shady.assignedSlot) {
      node.__shady.assignedSlot.__shady.dirty = true;
    }
  }
};

/**
 * Clears the assignedNodes tracking data for a given `slot`. Note, the current
 * assigned node data is tracked (via _previouslyAssignedNodes and
 * _prevAssignedSlot) to see if `slotchange` should fire. This data may be out
 *  of date at this time because the assigned nodes may have already been
 * distributed to another root. This is ok since this data is only used to
 * track changes.
 * @param {HTMLSlotElement} slot
 */
ShadyRoot.prototype._clearSlotAssignedNodes = function(slot) {
  let n$ = slot.__shady.assignedNodes;
  slot.__shady.assignedNodes = [];
  slot.__shady.flattenedNodes = [];
  slot.__shady._previouslyAssignedNodes = n$;
  if (n$) {
    for (let i=0; i < n$.length; i++) {
      let n = n$[i];
      n.__shady._prevAssignedSlot = n.__shady.assignedSlot;
      // only clear if it was previously set to this slot;
      // this helps ensure that if the node has otherwise been distributed
      // ignore it.
      if (n.__shady.assignedSlot === slot) {
        n.__shady.assignedSlot = null;
      }
    }
  }
};

ShadyRoot.prototype._addAssignedToFlattenedNodes = function(flattened, assigned) {
  for (let i=0, n; (i<assigned.length) && (n=assigned[i]); i++) {
    if (n.localName == 'slot') {
      const nestedAssigned = n.__shady.assignedNodes;
      if (nestedAssigned && nestedAssigned.length) {
        this._addAssignedToFlattenedNodes(flattened, nestedAssigned);
      }
    } else {
      flattened.push(assigned[i]);
    }
  }
};

ShadyRoot.prototype._fireSlotChange = function(slot) {
  // NOTE: cannot bubble correctly here so not setting bubbles: true
  // Safari tech preview does not bubble but chrome does
  // Spec says it bubbles (https://dom.spec.whatwg.org/#mutation-observers)
  dispatchEvent.call(slot, new Event('slotchange'));
  if (slot.__shady.assignedSlot) {
    this._fireSlotChange(slot.__shady.assignedSlot);
  }
};

// Reify dom such that it is at its correct rendering position
// based on logical distribution.
// NOTE: here we only compose parents of <slot> elements and not the
// shadowRoot into the host. The latter is performend via a fast path
// in the `logical-mutation`.insertBefore.
ShadyRoot.prototype._compose = function() {
  const slots = this._slotList;
  let composeList = [];
  for (let i=0; i < slots.length; i++) {
    const parent = slots[i].parentNode;
    /* compose node only if:
      (1) parent does not have a shadowRoot since shadowRoot has already
      composed into the host
      (2) we're not already composing it
      [consider (n^2) but rare better than Set]
    */
    if (!(parent.__shady && parent.__shady.root) &&
      composeList.indexOf(parent) < 0) {
      composeList.push(parent);
    }
  }
  for (let i=0; i < composeList.length; i++) {
    const node = composeList[i];
    const targetNode = node === this ? this.host : node;
    this._updateChildNodes(targetNode, this._composeNode(node));
  }
};

// Returns the list of nodes which should be rendered inside `node`.
ShadyRoot.prototype._composeNode = function(node) {
  let children$$1 = [];
  let c$ = node.childNodes;
  for (let i = 0; i < c$.length; i++) {
    let child = c$[i];
    // Note: if we see a slot here, the nodes are guaranteed to need to be
    // composed here. This is because if there is redistribution, it has
    // already been handled by this point.
    if (this._isInsertionPoint(child)) {
      let flattenedNodes = child.__shady.flattenedNodes;
      for (let j = 0; j < flattenedNodes.length; j++) {
        let distributedNode = flattenedNodes[j];
          children$$1.push(distributedNode);
      }
    } else {
      children$$1.push(child);
    }
  }
  return children$$1;
};

ShadyRoot.prototype._isInsertionPoint = function(node) {
    return node.localName == 'slot';
  };

// Ensures that the rendered node list inside `container` is `children`.
ShadyRoot.prototype._updateChildNodes = function(container, children$$1) {
  let composed = childNodes(container);
  let splices = calculateSplices(children$$1, composed);
  // process removals
  for (let i=0, d=0, s; (i<splices.length) && (s=splices[i]); i++) {
    for (let j=0, n; (j < s.removed.length) && (n=s.removed[j]); j++) {
      // check if the node is still where we expect it is before trying
      // to remove it; this can happen if we move a node and
      // then schedule its previous host for distribution resulting in
      // the node being removed here.
      if (parentNode(n) === container) {
        removeChild.call(container, n);
      }
      composed.splice(s.index + d, 1);
    }
    d -= s.addedCount;
  }
  // process adds
  for (let i=0, s, next; (i<splices.length) && (s=splices[i]); i++) { //eslint-disable-line no-redeclare
    next = composed[s.index];
    for (let j=s.index, n; j < s.index + s.addedCount; j++) {
      n = children$$1[j];
      insertBefore.call(container, n, next);
      composed.splice(j, 0, n);
    }
  }
};

ShadyRoot.prototype._addSlots = function(slots) {
  this.__pendingSlots.push(...slots);
};

ShadyRoot.prototype._validateSlots = function() {
  if (this.__pendingSlots.length) {
    this._mapSlots(this.__pendingSlots);
    this.__pendingSlots = [];
  }
};

/**
 * Adds the given slots. Slots are maintained in an dom-ordered list.
 * In addition a map of name to slot is updated.
 */
ShadyRoot.prototype._mapSlots = function(slots) {
  let slotNamesToSort;
  for (let i=0; i < slots.length; i++) {
    let slot = slots[i];
    // ensure insertionPoints's and their parents have logical dom info.
    // save logical tree info
    // a. for shadyRoot
    // b. for insertion points (fallback)
    // c. for parents of insertion points
    slot.__shady = slot.__shady || {};
    recordChildNodes(slot);
    recordChildNodes(slot.parentNode);
    let name = this._nameForSlot(slot);
    if (this._slotMap[name]) {
      slotNamesToSort = slotNamesToSort || {};
      slotNamesToSort[name] = true;
      this._slotMap[name].push(slot);
    } else {
      this._slotMap[name] = [slot];
    }
    this._slotList.push(slot);
  }
  if (slotNamesToSort) {
    for (let n in slotNamesToSort) {
      this._slotMap[n] = this._sortSlots(this._slotMap[n]);
    }
  }
};

ShadyRoot.prototype._nameForSlot = function(slot) {
  const name = slot['name'] || slot.getAttribute('name') || CATCHALL_NAME;
  slot.__slotName = name;
  return name;
};

/**
 * Slots are kept in an ordered list. Slots with the same name
 * are sorted here by tree order.
 */
ShadyRoot.prototype._sortSlots = function(slots) {
  // NOTE: Cannot use `compareDocumentPosition` because it's not polyfilled,
  // but the code here could be used to polyfill the preceeding/following info
  // in `compareDocumentPosition`.
  return slots.sort((a, b) => {
    let listA = ancestorList(a);
    let listB = ancestorList(b);
    for (var i=0; i < listA.length; i++) {
      let nA = listA[i];
      let nB = listB[i];
      if (nA !== nB) {
        let c$ = Array.from(nA.parentNode.childNodes);
        return c$.indexOf(nA) - c$.indexOf(nB);
      }
    }
  });
};

function ancestorList(node) {
  let ancestors = [];
  do {
    ancestors.unshift(node);
  } while ((node = node.parentNode));
  return ancestors;
}

/**
 * Removes from tracked slot data any slots contained within `container` and
 * then updates the tracked data (_slotList and _slotMap).
 * Any removed slots also have their `assignedNodes` removed from comopsed dom.
 */
ShadyRoot.prototype._removeContainedSlots = function(container) {
  this._validateSlots();
  let didRemove;
  const map = this._slotMap;
  for (let n in map) {
    let slots = map[n];
    for (let i=0; i < slots.length; i++) {
      let slot = slots[i];
      if (contains(container, slot)) {
        slots.splice(i, 1);
        const x = this._slotList.indexOf(slot);
        if (x >= 0) {
          this._slotList.splice(x, 1);
        }
        i--;
        this._removeFlattenedNodes(slot);
        didRemove = true;
      }
    }
  }
  return didRemove;
};

ShadyRoot.prototype._updateSlotName = function(slot) {
  const oldName = slot.__slotName;
  const name = this._nameForSlot(slot);
  if (name === oldName) {
    return;
  }
  // remove from existing tracking
  let slots = this._slotMap[oldName];
  const i = slots.indexOf(slot);
  if (i >= 0) {
    slots.splice(i, 1);
  }
  // add to new location and sort if nedessary
  let list = this._slotMap[name] || (this._slotMap[name] = []);
  list.push(slot);
  if (list.length > 1) {
    this._slotMap[name] = this._sortSlots(list);
  }
};

ShadyRoot.prototype._removeFlattenedNodes = function(slot) {
  let n$ = slot.__shady.flattenedNodes;
  if (n$) {
    for (let i=0; i<n$.length; i++) {
      let node = n$[i];
      let parent = parentNode(node);
      if (parent) {
        removeChild.call(parent, node);
      }
    }
  }
};

ShadyRoot.prototype._hasInsertionPoint = function() {
  this._validateSlots();
  return Boolean(this._slotList.length);
};

ShadyRoot.prototype.addEventListener = function(type, fn, optionsOrCapture) {
  if (typeof optionsOrCapture !== 'object') {
    optionsOrCapture = {
      capture: Boolean(optionsOrCapture)
    };
  }
  optionsOrCapture.__shadyTarget = this;
  this.host.addEventListener(type, fn, optionsOrCapture);
};

ShadyRoot.prototype.removeEventListener = function(type, fn, optionsOrCapture) {
  if (typeof optionsOrCapture !== 'object') {
    optionsOrCapture = {
      capture: Boolean(optionsOrCapture)
    };
  }
  optionsOrCapture.__shadyTarget = this;
  this.host.removeEventListener(type, fn, optionsOrCapture);
};

ShadyRoot.prototype.getElementById = function(id) {
  let result = query(this, function(n) {
    return n.id == id;
  }, function(n) {
    return Boolean(n);
  })[0];
  return result || null;
};

/**
  Implements a pared down version of ShadowDOM's scoping, which is easy to
  polyfill across browsers.
*/
function attachShadow(host, options) {
  if (!host) {
    throw 'Must provide a host.';
  }
  if (!options) {
    throw 'Not enough arguments.'
  }
  return new ShadyRoot(ShadyRootConstructionToken, host, options);
}

patchShadowRootAccessors(ShadyRoot.prototype);

/**
@license
Copyright (c) 2016 The Polymer Project Authors. All rights reserved.
This code may only be used under the BSD style license found at http://polymer.github.io/LICENSE.txt
The complete set of authors may be found at http://polymer.github.io/AUTHORS.txt
The complete set of contributors may be found at http://polymer.github.io/CONTRIBUTORS.txt
Code distributed by Google as part of the polymer project is also
subject to an additional IP rights grant found at http://polymer.github.io/PATENTS.txt
*/

function getAssignedSlot(node) {
  renderRootNode(node);
  return node.__shady && node.__shady.assignedSlot || null;
}

let windowMixin = {

  // NOTE: ensure these methods are bound to `window` so that `this` is correct
  // when called directly from global context without a receiver; e.g.
  // `addEventListener(...)`.
  addEventListener: addEventListener$1.bind(window),

  removeEventListener: removeEventListener$1.bind(window)

};

let nodeMixin = {

  addEventListener: addEventListener$1,

  removeEventListener: removeEventListener$1,

  appendChild(node) {
    return insertBefore$1(this, node);
  },

  insertBefore(node, ref_node) {
    return insertBefore$1(this, node, ref_node);
  },

  removeChild(node) {
    return removeChild$1(this, node);
  },

  /**
   * @this {Node}
   */
  replaceChild(node, ref_node) {
    insertBefore$1(this, node, ref_node);
    removeChild$1(this, ref_node);
    return node;
  },

  /**
   * @this {Node}
   */
  cloneNode(deep) {
    return cloneNode$1(this, deep);
  },

  /**
   * @this {Node}
   */
  getRootNode(options) {
    return getRootNode(this, options);
  },

  contains(node) {
    return contains(this, node);
  },

  /**
   * @this {Node}
   */
  get isConnected() {
    // Fast path for distributed nodes.
    const ownerDocument = this.ownerDocument;
    if (hasDocumentContains && contains$1.call(ownerDocument, this)) {
      return true;
    }
    if (ownerDocument.documentElement &&
      contains$1.call(ownerDocument.documentElement, this)) {
      return true;
    }
    let node = this;
    while (node && !(node instanceof Document)) {
      node = node.parentNode || (node instanceof ShadyRoot ? /** @type {ShadowRoot} */(node).host : undefined);
    }
    return !!(node && node instanceof Document);
  },

  /**
   * @this {Node}
   */
  dispatchEvent(event) {
    flush();
    return dispatchEvent.call(this, event);
  }

};

// NOTE: For some reason 'Text' redefines 'assignedSlot'
let textMixin = {
  /**
   * @this {Text}
   */
  get assignedSlot() {
    return getAssignedSlot(this);
  }
};

let fragmentMixin = {

  // TODO(sorvell): consider doing native QSA and filtering results.
  /**
   * @this {DocumentFragment}
   */
  querySelector(selector) {
    // match selector and halt on first result.
    let result = query(this, function(n) {
      return matchesSelector(n, selector);
    }, function(n) {
      return Boolean(n);
    })[0];
    return result || null;
  },

  /**
   * @this {DocumentFragment}
   */
  querySelectorAll(selector) {
    return query(this, function(n) {
      return matchesSelector(n, selector);
    });
  }

};

let slotMixin = {

  /**
   * @this {HTMLSlotElement}
   */
  assignedNodes(options) {
    if (this.localName === 'slot') {
      renderRootNode(this);
      return this.__shady ?
        ((options && options.flatten ? this.__shady.flattenedNodes :
        this.__shady.assignedNodes) || []) :
        [];
    }
  }

};

let elementMixin = extendAll({

  /**
   * @this {HTMLElement}
   */
  setAttribute(name, value) {
    setAttribute$1(this, name, value);
  },

  /**
   * @this {HTMLElement}
   */
  removeAttribute(name) {
    removeAttribute$1(this, name);
  },

  /**
   * @this {HTMLElement}
   */
  attachShadow(options) {
    return attachShadow(this, options);
  },

  /**
   * @this {HTMLElement}
   */
  get slot() {
    return this.getAttribute('slot');
  },

  /**
   * @this {HTMLElement}
   */
  set slot(value) {
    setAttribute$1(this, 'slot', value);
  },

  /**
   * @this {HTMLElement}
   */
  get assignedSlot() {
    return getAssignedSlot(this);
  }

}, fragmentMixin, slotMixin);

Object.defineProperties(elementMixin, ShadowRootAccessor);

let documentMixin = extendAll({
  /**
   * @this {Document}
   */
  importNode(node, deep) {
    return importNode$1(node, deep);
  },

  /**
   * @this {Document}
   */
  getElementById(id) {
    let result = query(this, function(n) {
      return n.id == id;
    }, function(n) {
      return Boolean(n);
    })[0];
    return result || null;
  }

}, fragmentMixin);

Object.defineProperties(documentMixin, {
  '_activeElement': ActiveElementAccessor.activeElement
});

let nativeBlur = HTMLElement.prototype.blur;

let htmlElementMixin = extendAll({
  /**
   * @this {HTMLElement}
   */
  blur() {
    let root = this.__shady && this.__shady.root;
    let shadowActive = root && root.activeElement;
    if (shadowActive) {
      shadowActive.blur();
    } else {
      nativeBlur.call(this);
    }
  }
});

function patchBuiltin(proto, obj) {
  let n$ = Object.getOwnPropertyNames(obj);
  for (let i=0; i < n$.length; i++) {
    let n = n$[i];
    let d = Object.getOwnPropertyDescriptor(obj, n);
    // NOTE: we prefer writing directly here because some browsers
    // have descriptors that are writable but not configurable (e.g.
    // `appendChild` on older browsers)
    if (d.value) {
      proto[n] = d.value;
    } else {
      Object.defineProperty(proto, n, d);
    }
  }
}


// Apply patches to builtins (e.g. Element.prototype). Some of these patches
// can be done unconditionally (mostly methods like
// `Element.prototype.appendChild`) and some can only be done when the browser
// has proper descriptors on the builtin prototype
// (e.g. `Element.prototype.firstChild`)`. When descriptors are not available,
// elements are individually patched when needed (see e.g.
// `patchInside/OutsideElementAccessors` in `patch-accessors.js`).
function patchBuiltins() {
  let nativeHTMLElement =
    (window['customElements'] && window['customElements']['nativeHTMLElement']) ||
    HTMLElement;
  // These patches can always be done, for all supported browsers.
  patchBuiltin(window.Node.prototype, nodeMixin);
  patchBuiltin(window.Window.prototype, windowMixin);
  patchBuiltin(window.Text.prototype, textMixin);
  patchBuiltin(window.DocumentFragment.prototype, fragmentMixin);
  patchBuiltin(window.Element.prototype, elementMixin);
  patchBuiltin(window.Document.prototype, documentMixin);
  if (window.HTMLSlotElement) {
    patchBuiltin(window.HTMLSlotElement.prototype, slotMixin);
  }
  patchBuiltin(nativeHTMLElement.prototype, htmlElementMixin);
  // These patches can *only* be done
  // on browsers that have proper property descriptors on builtin prototypes.
  // This includes: IE11, Edge, Chrome >= 4?; Safari >= 10, Firefox
  // On older browsers (Chrome <= 4?, Safari 9), a per element patching
  // strategy is used for patching accessors.
  if (settings.hasDescriptors) {
    patchAccessors(window.Node.prototype);
    patchAccessors(window.Text.prototype);
    patchAccessors(window.DocumentFragment.prototype);
    patchAccessors(window.Element.prototype);
    patchAccessors(nativeHTMLElement.prototype);
    patchAccessors(window.Document.prototype);
    if (window.HTMLSlotElement) {
      patchAccessors(window.HTMLSlotElement.prototype);
    }
  }
}

/**
@license
Copyright (c) 2016 The Polymer Project Authors. All rights reserved.
This code may only be used under the BSD style license found at http://polymer.github.io/LICENSE.txt
The complete set of authors may be found at http://polymer.github.io/AUTHORS.txt
The complete set of contributors may be found at http://polymer.github.io/CONTRIBUTORS.txt
Code distributed by Google as part of the polymer project is also
subject to an additional IP rights grant found at http://polymer.github.io/PATENTS.txt
*/

/**
 * Patches elements that interacts with ShadyDOM
 * such that tree traversal and mutation apis act like they would under
 * ShadowDOM.
 *
 * This import enables seemless interaction with ShadyDOM powered
 * custom elements, enabling better interoperation with 3rd party code,
 * libraries, and frameworks that use DOM tree manipulation apis.
 */

if (settings.inUse) {
  let ShadyDOM = {
    // TODO(sorvell): remove when Polymer does not depend on this.
    'inUse': settings.inUse,
    // TODO(sorvell): remove when Polymer does not depend on this
    'patch': (node) => node,
    'isShadyRoot': isShadyRoot,
    'enqueue': enqueue,
    'flush': flush,
    'settings': settings,
    'filterMutations': filterMutations,
    'observeChildren': observeChildren,
    'unobserveChildren': unobserveChildren,
    'nativeMethods': nativeMethods,
    'nativeTree': nativeTree
  };

  window['ShadyDOM'] = ShadyDOM;

  // Apply patches to events...
  patchEvents();
  // Apply patches to builtins (e.g. Element.prototype) where applicable.
  patchBuiltins();

  window.ShadowRoot = ShadyRoot;
}

const reservedTagList = new Set([
  'annotation-xml',
  'color-profile',
  'font-face',
  'font-face-src',
  'font-face-uri',
  'font-face-format',
  'font-face-name',
  'missing-glyph',
]);

/**
 * @param {string} localName
 * @returns {boolean}
 */
function isValidCustomElementName(localName) {
  const reserved = reservedTagList.has(localName);
  const validForm = /^[a-z][.0-9_a-z]*-[\-.0-9_a-z]*$/.test(localName);
  return !reserved && validForm;
}

/**
 * @private
 * @param {!Node} node
 * @return {boolean}
 */
function isConnected(node) {
  // Use `Node#isConnected`, if defined.
  const nativeValue = node.isConnected;
  if (nativeValue !== undefined) {
    return nativeValue;
  }

  /** @type {?Node|undefined} */
  let current = node;
  while (current && !(current.__CE_isImportDocument || current instanceof Document)) {
    current = current.parentNode || (window.ShadowRoot && current instanceof ShadowRoot ? current.host : undefined);
  }
  return !!(current && (current.__CE_isImportDocument || current instanceof Document));
}

/**
 * @param {!Node} root
 * @param {!Node} start
 * @return {?Node}
 */
function nextSiblingOrAncestorSibling(root, start) {
  let node = start;
  while (node && node !== root && !node.nextSibling) {
    node = node.parentNode;
  }
  return (!node || node === root) ? null : node.nextSibling;
}

/**
 * @param {!Node} root
 * @param {!Node} start
 * @return {?Node}
 */
function nextNode(root, start) {
  return start.firstChild ? start.firstChild : nextSiblingOrAncestorSibling(root, start);
}

/**
 * @param {!Node} root
 * @param {!function(!Element)} callback
 * @param {!Set<Node>=} visitedImports
 */
function walkDeepDescendantElements(root, callback, visitedImports = new Set()) {
  let node = root;
  while (node) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      const element = /** @type {!Element} */(node);

      callback(element);

      const localName = element.localName;
      if (localName === 'link' && element.getAttribute('rel') === 'import') {
        // If this import (polyfilled or not) has it's root node available,
        // walk it.
        const importNode = /** @type {!Node} */ (element.import);
        if (importNode instanceof Node && !visitedImports.has(importNode)) {
          // Prevent multiple walks of the same import root.
          visitedImports.add(importNode);

          for (let child = importNode.firstChild; child; child = child.nextSibling) {
            walkDeepDescendantElements(child, callback, visitedImports);
          }
        }

        // Ignore descendants of import links to prevent attempting to walk the
        // elements created by the HTML Imports polyfill that we just walked
        // above.
        node = nextSiblingOrAncestorSibling(root, element);
        continue;
      } else if (localName === 'template') {
        // Ignore descendants of templates. There shouldn't be any descendants
        // because they will be moved into `.content` during construction in
        // browsers that support template but, in case they exist and are still
        // waiting to be moved by a polyfill, they will be ignored.
        node = nextSiblingOrAncestorSibling(root, element);
        continue;
      }

      // Walk shadow roots.
      const shadowRoot = element.__CE_shadowRoot;
      if (shadowRoot) {
        for (let child = shadowRoot.firstChild; child; child = child.nextSibling) {
          walkDeepDescendantElements(child, callback, visitedImports);
        }
      }
    }

    node = nextNode(root, node);
  }
}

/**
 * Used to suppress Closure's "Modifying the prototype is only allowed if the
 * constructor is in the same scope" warning without using
 * `@suppress {newCheckTypes, duplicate}` because `newCheckTypes` is too broad.
 *
 * @param {!Object} destination
 * @param {string} name
 * @param {*} value
 */
function setPropertyUnchecked(destination, name, value) {
  destination[name] = value;
}

/**
 * @enum {number}
 */
const CustomElementState = {
  custom: 1,
  failed: 2,
};

class CustomElementInternals {
  constructor() {
    /** @type {!Map<string, !CustomElementDefinition>} */
    this._localNameToDefinition = new Map();

    /** @type {!Map<!Function, !CustomElementDefinition>} */
    this._constructorToDefinition = new Map();

    /** @type {!Array<!function(!Node)>} */
    this._patches = [];

    /** @type {boolean} */
    this._hasPatches = false;
  }

  /**
   * @param {string} localName
   * @param {!CustomElementDefinition} definition
   */
  setDefinition(localName, definition) {
    this._localNameToDefinition.set(localName, definition);
    this._constructorToDefinition.set(definition.constructor, definition);
  }

  /**
   * @param {string} localName
   * @return {!CustomElementDefinition|undefined}
   */
  localNameToDefinition(localName) {
    return this._localNameToDefinition.get(localName);
  }

  /**
   * @param {!Function} constructor
   * @return {!CustomElementDefinition|undefined}
   */
  constructorToDefinition(constructor) {
    return this._constructorToDefinition.get(constructor);
  }

  /**
   * @param {!function(!Node)} listener
   */
  addPatch(listener) {
    this._hasPatches = true;
    this._patches.push(listener);
  }

  /**
   * @param {!Node} node
   */
  patchTree(node) {
    if (!this._hasPatches) return;

    walkDeepDescendantElements(node, element => this.patch(element));
  }

  /**
   * @param {!Node} node
   */
  patch(node) {
    if (!this._hasPatches) return;

    if (node.__CE_patched) return;
    node.__CE_patched = true;

    for (let i = 0; i < this._patches.length; i++) {
      this._patches[i](node);
    }
  }

  /**
   * @param {!Node} root
   */
  connectTree(root) {
    const elements = [];

    walkDeepDescendantElements(root, element => elements.push(element));

    for (let i = 0; i < elements.length; i++) {
      const element = elements[i];
      if (element.__CE_state === CustomElementState.custom) {
        this.connectedCallback(element);
      } else {
        this.upgradeElement(element);
      }
    }
  }

  /**
   * @param {!Node} root
   */
  disconnectTree(root) {
    const elements = [];

    walkDeepDescendantElements(root, element => elements.push(element));

    for (let i = 0; i < elements.length; i++) {
      const element = elements[i];
      if (element.__CE_state === CustomElementState.custom) {
        this.disconnectedCallback(element);
      }
    }
  }

  /**
   * Upgrades all uncustomized custom elements at and below a root node for
   * which there is a definition. When custom element reaction callbacks are
   * assumed to be called synchronously (which, by the current DOM / HTML spec
   * definitions, they are *not*), callbacks for both elements customized
   * synchronously by the parser and elements being upgraded occur in the same
   * relative order.
   *
   * NOTE: This function, when used to simulate the construction of a tree that
   * is already created but not customized (i.e. by the parser), does *not*
   * prevent the element from reading the 'final' (true) state of the tree. For
   * example, the element, during truly synchronous parsing / construction would
   * see that it contains no children as they have not yet been inserted.
   * However, this function does not modify the tree, the element will
   * (incorrectly) have children. Additionally, self-modification restrictions
   * for custom element constructors imposed by the DOM spec are *not* enforced.
   *
   *
   * The following nested list shows the steps extending down from the HTML
   * spec's parsing section that cause elements to be synchronously created and
   * upgraded:
   *
   * The "in body" insertion mode:
   * https://html.spec.whatwg.org/multipage/syntax.html#parsing-main-inbody
   * - Switch on token:
   *   .. other cases ..
   *   -> Any other start tag
   *      - [Insert an HTML element](below) for the token.
   *
   * Insert an HTML element:
   * https://html.spec.whatwg.org/multipage/syntax.html#insert-an-html-element
   * - Insert a foreign element for the token in the HTML namespace:
   *   https://html.spec.whatwg.org/multipage/syntax.html#insert-a-foreign-element
   *   - Create an element for a token:
   *     https://html.spec.whatwg.org/multipage/syntax.html#create-an-element-for-the-token
   *     - Will execute script flag is true?
   *       - (Element queue pushed to the custom element reactions stack.)
   *     - Create an element:
   *       https://dom.spec.whatwg.org/#concept-create-element
   *       - Sync CE flag is true?
   *         - Constructor called.
   *         - Self-modification restrictions enforced.
   *       - Sync CE flag is false?
   *         - (Upgrade reaction enqueued.)
   *     - Attributes appended to element.
   *       (`attributeChangedCallback` reactions enqueued.)
   *     - Will execute script flag is true?
   *       - (Element queue popped from the custom element reactions stack.
   *         Reactions in the popped stack are invoked.)
   *   - (Element queue pushed to the custom element reactions stack.)
   *   - Insert the element:
   *     https://dom.spec.whatwg.org/#concept-node-insert
   *     - Shadow-including descendants are connected. During parsing
   *       construction, there are no shadow-*excluding* descendants.
   *       However, the constructor may have validly attached a shadow
   *       tree to itself and added descendants to that shadow tree.
   *       (`connectedCallback` reactions enqueued.)
   *   - (Element queue popped from the custom element reactions stack.
   *     Reactions in the popped stack are invoked.)
   *
   * @param {!Node} root
   * @param {{
   *   visitedImports: (!Set<!Node>|undefined),
   *   upgrade: (!function(!Element)|undefined),
   * }=} options
   */
  patchAndUpgradeTree(root, options = {}) {
    const visitedImports = options.visitedImports || new Set();
    const upgrade = options.upgrade || (element => this.upgradeElement(element));

    const elements = [];

    const gatherElements = element => {
      if (element.localName === 'link' && element.getAttribute('rel') === 'import') {
        // The HTML Imports polyfill sets a descendant element of the link to
        // the `import` property, specifically this is *not* a Document.
        const importNode = /** @type {?Node} */ (element.import);

        if (importNode instanceof Node) {
          importNode.__CE_isImportDocument = true;
          // Connected links are associated with the registry.
          importNode.__CE_hasRegistry = true;
        }

        if (importNode && importNode.readyState === 'complete') {
          importNode.__CE_documentLoadHandled = true;
        } else {
          // If this link's import root is not available, its contents can't be
          // walked. Wait for 'load' and walk it when it's ready.
          element.addEventListener('load', () => {
            const importNode = /** @type {!Node} */ (element.import);

            if (importNode.__CE_documentLoadHandled) return;
            importNode.__CE_documentLoadHandled = true;

            // Clone the `visitedImports` set that was populated sync during
            // the `patchAndUpgradeTree` call that caused this 'load' handler to
            // be added. Then, remove *this* link's import node so that we can
            // walk that import again, even if it was partially walked later
            // during the same `patchAndUpgradeTree` call.
            const clonedVisitedImports = new Set(visitedImports);
            clonedVisitedImports.delete(importNode);

            this.patchAndUpgradeTree(importNode, {visitedImports: clonedVisitedImports, upgrade});
          });
        }
      } else {
        elements.push(element);
      }
    };

    // `walkDeepDescendantElements` populates (and internally checks against)
    // `visitedImports` when traversing a loaded import.
    walkDeepDescendantElements(root, gatherElements, visitedImports);

    if (this._hasPatches) {
      for (let i = 0; i < elements.length; i++) {
        this.patch(elements[i]);
      }
    }

    for (let i = 0; i < elements.length; i++) {
      upgrade(elements[i]);
    }
  }

  /**
   * @param {!Element} element
   */
  upgradeElement(element) {
    const currentState = element.__CE_state;
    if (currentState !== undefined) return;

    // Prevent elements created in documents without a browsing context from
    // upgrading.
    //
    // https://html.spec.whatwg.org/multipage/custom-elements.html#look-up-a-custom-element-definition
    //   "If document does not have a browsing context, return null."
    //
    // https://html.spec.whatwg.org/multipage/window-object.html#dom-document-defaultview
    //   "The defaultView IDL attribute of the Document interface, on getting,
    //   must return this Document's browsing context's WindowProxy object, if
    //   this Document has an associated browsing context, or null otherwise."
    const ownerDocument = element.ownerDocument;
    if (
      !ownerDocument.defaultView &&
      !(ownerDocument.__CE_isImportDocument && ownerDocument.__CE_hasRegistry)
    ) return;

    const definition = this.localNameToDefinition(element.localName);
    if (!definition) return;

    definition.constructionStack.push(element);

    const constructor = definition.constructor;
    try {
      try {
        let result = new (constructor)();
        if (result !== element) {
          throw new Error('The custom element constructor did not produce the element being upgraded.');
        }
      } finally {
        definition.constructionStack.pop();
      }
    } catch (e) {
      element.__CE_state = CustomElementState.failed;
      throw e;
    }

    element.__CE_state = CustomElementState.custom;
    element.__CE_definition = definition;

    if (definition.attributeChangedCallback) {
      const observedAttributes = definition.observedAttributes;
      for (let i = 0; i < observedAttributes.length; i++) {
        const name = observedAttributes[i];
        const value = element.getAttribute(name);
        if (value !== null) {
          this.attributeChangedCallback(element, name, null, value, null);
        }
      }
    }

    if (isConnected(element)) {
      this.connectedCallback(element);
    }
  }

  /**
   * @param {!Element} element
   */
  connectedCallback(element) {
    const definition = element.__CE_definition;
    if (definition.connectedCallback) {
      definition.connectedCallback.call(element);
    }
  }

  /**
   * @param {!Element} element
   */
  disconnectedCallback(element) {
    const definition = element.__CE_definition;
    if (definition.disconnectedCallback) {
      definition.disconnectedCallback.call(element);
    }
  }

  /**
   * @param {!Element} element
   * @param {string} name
   * @param {?string} oldValue
   * @param {?string} newValue
   * @param {?string} namespace
   */
  attributeChangedCallback(element, name, oldValue, newValue, namespace) {
    const definition = element.__CE_definition;
    if (
      definition.attributeChangedCallback &&
      definition.observedAttributes.indexOf(name) > -1
    ) {
      definition.attributeChangedCallback.call(element, name, oldValue, newValue, namespace);
    }
  }
}

class DocumentConstructionObserver {
  constructor(internals, doc) {
    /**
     * @type {!CustomElementInternals}
     */
    this._internals = internals;

    /**
     * @type {!Document}
     */
    this._document = doc;

    /**
     * @type {MutationObserver|undefined}
     */
    this._observer = undefined;


    // Simulate tree construction for all currently accessible nodes in the
    // document.
    this._internals.patchAndUpgradeTree(this._document);

    if (this._document.readyState === 'loading') {
      this._observer = new MutationObserver(this._handleMutations.bind(this));

      // Nodes created by the parser are given to the observer *before* the next
      // task runs. Inline scripts are run in a new task. This means that the
      // observer will be able to handle the newly parsed nodes before the inline
      // script is run.
      this._observer.observe(this._document, {
        childList: true,
        subtree: true,
      });
    }
  }

  disconnect() {
    if (this._observer) {
      this._observer.disconnect();
    }
  }

  /**
   * @param {!Array<!MutationRecord>} mutations
   */
  _handleMutations(mutations) {
    // Once the document's `readyState` is 'interactive' or 'complete', all new
    // nodes created within that document will be the result of script and
    // should be handled by patching.
    const readyState = this._document.readyState;
    if (readyState === 'interactive' || readyState === 'complete') {
      this.disconnect();
    }

    for (let i = 0; i < mutations.length; i++) {
      const addedNodes = mutations[i].addedNodes;
      for (let j = 0; j < addedNodes.length; j++) {
        const node = addedNodes[j];
        this._internals.patchAndUpgradeTree(node);
      }
    }
  }
}

/**
 * @template T
 */
class Deferred {
  constructor() {
    /**
     * @private
     * @type {T|undefined}
     */
    this._value = undefined;

    /**
     * @private
     * @type {Function|undefined}
     */
    this._resolve = undefined;

    /**
     * @private
     * @type {!Promise<T>}
     */
    this._promise = new Promise(resolve => {
      this._resolve = resolve;

      if (this._value) {
        resolve(this._value);
      }
    });
  }

  /**
   * @param {T} value
   */
  resolve(value) {
    if (this._value) {
      throw new Error('Already resolved.');
    }

    this._value = value;

    if (this._resolve) {
      this._resolve(value);
    }
  }

  /**
   * @return {!Promise<T>}
   */
  toPromise() {
    return this._promise;
  }
}

/**
 * @unrestricted
 */
class CustomElementRegistry {

  /**
   * @param {!CustomElementInternals} internals
   */
  constructor(internals) {
    /**
     * @private
     * @type {boolean}
     */
    this._elementDefinitionIsRunning = false;

    /**
     * @private
     * @type {!CustomElementInternals}
     */
    this._internals = internals;

    /**
     * @private
     * @type {!Map<string, !Deferred<undefined>>}
     */
    this._whenDefinedDeferred = new Map();

    /**
     * The default flush callback triggers the document walk synchronously.
     * @private
     * @type {!Function}
     */
    this._flushCallback = fn => fn();

    /**
     * @private
     * @type {boolean}
     */
    this._flushPending = false;

    /**
     * @private
     * @type {!Array<!CustomElementDefinition>}
     */
    this._pendingDefinitions = [];

    /**
     * @private
     * @type {!DocumentConstructionObserver}
     */
    this._documentConstructionObserver = new DocumentConstructionObserver(internals, document);
  }

  /**
   * @param {string} localName
   * @param {!Function} constructor
   */
  define(localName, constructor) {
    if (!(constructor instanceof Function)) {
      throw new TypeError('Custom element constructors must be functions.');
    }

    if (!isValidCustomElementName(localName)) {
      throw new SyntaxError(`The element name '${localName}' is not valid.`);
    }

    if (this._internals.localNameToDefinition(localName)) {
      throw new Error(`A custom element with name '${localName}' has already been defined.`);
    }

    if (this._elementDefinitionIsRunning) {
      throw new Error('A custom element is already being defined.');
    }
    this._elementDefinitionIsRunning = true;

    let connectedCallback;
    let disconnectedCallback;
    let adoptedCallback;
    let attributeChangedCallback;
    let observedAttributes;
    try {
      /** @type {!Object} */
      const prototype = constructor.prototype;
      if (!(prototype instanceof Object)) {
        throw new TypeError('The custom element constructor\'s prototype is not an object.');
      }

      function getCallback(name) {
        const callbackValue = prototype[name];
        if (callbackValue !== undefined && !(callbackValue instanceof Function)) {
          throw new Error(`The '${name}' callback must be a function.`);
        }
        return callbackValue;
      }

      connectedCallback = getCallback('connectedCallback');
      disconnectedCallback = getCallback('disconnectedCallback');
      adoptedCallback = getCallback('adoptedCallback');
      attributeChangedCallback = getCallback('attributeChangedCallback');
      observedAttributes = constructor['observedAttributes'] || [];
    } catch (e) {
      return;
    } finally {
      this._elementDefinitionIsRunning = false;
    }

    const definition = {
      localName,
      constructor,
      connectedCallback,
      disconnectedCallback,
      adoptedCallback,
      attributeChangedCallback,
      observedAttributes,
      constructionStack: [],
    };

    this._internals.setDefinition(localName, definition);
    this._pendingDefinitions.push(definition);

    // If we've already called the flush callback and it hasn't called back yet,
    // don't call it again.
    if (!this._flushPending) {
      this._flushPending = true;
      this._flushCallback(() => this._flush());
    }
  }

  _flush() {
    // If no new definitions were defined, don't attempt to flush. This could
    // happen if a flush callback keeps the function it is given and calls it
    // multiple times.
    if (this._flushPending === false) return;
    this._flushPending = false;

    const pendingDefinitions = this._pendingDefinitions;

    /**
     * Unupgraded elements with definitions that were defined *before* the last
     * flush, in document order.
     * @type {!Array<!Element>}
     */
    const elementsWithStableDefinitions = [];

    /**
     * A map from `localName`s of definitions that were defined *after* the last
     * flush to unupgraded elements matching that definition, in document order.
     * @type {!Map<string, !Array<!Element>>}
     */
    const elementsWithPendingDefinitions = new Map();
    for (let i = 0; i < pendingDefinitions.length; i++) {
      elementsWithPendingDefinitions.set(pendingDefinitions[i].localName, []);
    }

    this._internals.patchAndUpgradeTree(document, {
      upgrade: element => {
        // Ignore the element if it has already upgraded or failed to upgrade.
        if (element.__CE_state !== undefined) return;

        const localName = element.localName;

        // If there is an applicable pending definition for the element, add the
        // element to the list of elements to be upgraded with that definition.
        const pendingElements = elementsWithPendingDefinitions.get(localName);
        if (pendingElements) {
          pendingElements.push(element);
        // If there is *any other* applicable definition for the element, add it
        // to the list of elements with stable definitions that need to be upgraded.
        } else if (this._internals.localNameToDefinition(localName)) {
          elementsWithStableDefinitions.push(element);
        }
      },
    });

    // Upgrade elements with 'stable' definitions first.
    for (let i = 0; i < elementsWithStableDefinitions.length; i++) {
      this._internals.upgradeElement(elementsWithStableDefinitions[i]);
    }

    // Upgrade elements with 'pending' definitions in the order they were defined.
    while (pendingDefinitions.length > 0) {
      const definition = pendingDefinitions.shift();
      const localName = definition.localName;

      // Attempt to upgrade all applicable elements.
      const pendingUpgradableElements = elementsWithPendingDefinitions.get(definition.localName);
      for (let i = 0; i < pendingUpgradableElements.length; i++) {
        this._internals.upgradeElement(pendingUpgradableElements[i]);
      }

      // Resolve any promises created by `whenDefined` for the definition.
      const deferred = this._whenDefinedDeferred.get(localName);
      if (deferred) {
        deferred.resolve(undefined);
      }
    }
  }

  /**
   * @param {string} localName
   * @return {Function|undefined}
   */
  get(localName) {
    const definition = this._internals.localNameToDefinition(localName);
    if (definition) {
      return definition.constructor;
    }

    return undefined;
  }

  /**
   * @param {string} localName
   * @return {!Promise<undefined>}
   */
  whenDefined(localName) {
    if (!isValidCustomElementName(localName)) {
      return Promise.reject(new SyntaxError(`'${localName}' is not a valid custom element name.`));
    }

    const prior = this._whenDefinedDeferred.get(localName);
    if (prior) {
      return prior.toPromise();
    }

    const deferred = new Deferred();
    this._whenDefinedDeferred.set(localName, deferred);

    const definition = this._internals.localNameToDefinition(localName);
    // Resolve immediately only if the given local name has a definition *and*
    // the full document walk to upgrade elements with that local name has
    // already happened.
    if (definition && !this._pendingDefinitions.some(d => d.localName === localName)) {
      deferred.resolve(undefined);
    }

    return deferred.toPromise();
  }

  polyfillWrapFlushCallback(outer) {
    this._documentConstructionObserver.disconnect();
    const inner = this._flushCallback;
    this._flushCallback = flush => outer(() => inner(flush));
  }
}

// Closure compiler exports.
window['CustomElementRegistry'] = CustomElementRegistry;
CustomElementRegistry.prototype['define'] = CustomElementRegistry.prototype.define;
CustomElementRegistry.prototype['get'] = CustomElementRegistry.prototype.get;
CustomElementRegistry.prototype['whenDefined'] = CustomElementRegistry.prototype.whenDefined;
CustomElementRegistry.prototype['polyfillWrapFlushCallback'] = CustomElementRegistry.prototype.polyfillWrapFlushCallback;

var Native = {
  Document_createElement: window.Document.prototype.createElement,
  Document_createElementNS: window.Document.prototype.createElementNS,
  Document_importNode: window.Document.prototype.importNode,
  Document_prepend: window.Document.prototype['prepend'],
  Document_append: window.Document.prototype['append'],
  DocumentFragment_prepend: window.DocumentFragment.prototype['prepend'],
  DocumentFragment_append: window.DocumentFragment.prototype['append'],
  Node_cloneNode: window.Node.prototype.cloneNode,
  Node_appendChild: window.Node.prototype.appendChild,
  Node_insertBefore: window.Node.prototype.insertBefore,
  Node_removeChild: window.Node.prototype.removeChild,
  Node_replaceChild: window.Node.prototype.replaceChild,
  Node_textContent: Object.getOwnPropertyDescriptor(window.Node.prototype, 'textContent'),
  Element_attachShadow: window.Element.prototype['attachShadow'],
  Element_innerHTML: Object.getOwnPropertyDescriptor(window.Element.prototype, 'innerHTML'),
  Element_getAttribute: window.Element.prototype.getAttribute,
  Element_setAttribute: window.Element.prototype.setAttribute,
  Element_removeAttribute: window.Element.prototype.removeAttribute,
  Element_getAttributeNS: window.Element.prototype.getAttributeNS,
  Element_setAttributeNS: window.Element.prototype.setAttributeNS,
  Element_removeAttributeNS: window.Element.prototype.removeAttributeNS,
  Element_insertAdjacentElement: window.Element.prototype['insertAdjacentElement'],
  Element_prepend: window.Element.prototype['prepend'],
  Element_append: window.Element.prototype['append'],
  Element_before: window.Element.prototype['before'],
  Element_after: window.Element.prototype['after'],
  Element_replaceWith: window.Element.prototype['replaceWith'],
  Element_remove: window.Element.prototype['remove'],
  HTMLElement: window.HTMLElement,
  HTMLElement_innerHTML: Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, 'innerHTML'),
  HTMLElement_insertAdjacentElement: window.HTMLElement.prototype['insertAdjacentElement'],
};

/**
 * This class exists only to work around Closure's lack of a way to describe
 * singletons. It represents the 'already constructed marker' used in custom
 * element construction stacks.
 *
 * https://html.spec.whatwg.org/#concept-already-constructed-marker
 */
class AlreadyConstructedMarker {}

var AlreadyConstructedMarker$1 = new AlreadyConstructedMarker();

/**
 * @param {!CustomElementInternals} internals
 */
var PatchHTMLElement = function(internals) {
  window['HTMLElement'] = (function() {
    /**
     * @type {function(new: HTMLElement): !HTMLElement}
     */
    function HTMLElement() {
      // This should really be `new.target` but `new.target` can't be emulated
      // in ES5. Assuming the user keeps the default value of the constructor's
      // prototype's `constructor` property, this is equivalent.
      /** @type {!Function} */
      const constructor = this.constructor;

      const definition = internals.constructorToDefinition(constructor);
      if (!definition) {
        throw new Error('The custom element being constructed was not registered with `customElements`.');
      }

      const constructionStack = definition.constructionStack;

      if (constructionStack.length === 0) {
        const element = Native.Document_createElement.call(document, definition.localName);
        Object.setPrototypeOf(element, constructor.prototype);
        element.__CE_state = CustomElementState.custom;
        element.__CE_definition = definition;
        internals.patch(element);
        return element;
      }

      const lastIndex = constructionStack.length - 1;
      const element = constructionStack[lastIndex];
      if (element === AlreadyConstructedMarker$1) {
        throw new Error('The HTMLElement constructor was either called reentrantly for this constructor or called multiple times.');
      }
      constructionStack[lastIndex] = AlreadyConstructedMarker$1;

      Object.setPrototypeOf(element, constructor.prototype);
      internals.patch(/** @type {!HTMLElement} */ (element));

      return element;
    }

    HTMLElement.prototype = Native.HTMLElement.prototype;

    return HTMLElement;
  })();
};

/**
 * @param {!CustomElementInternals} internals
 * @param {!Object} destination
 * @param {!ParentNodeNativeMethods} builtIn
 */
var PatchParentNode = function(internals, destination, builtIn) {
  /**
   * @param {!function(...(!Node|string))} builtInMethod
   * @return {!function(...(!Node|string))}
   */
  function appendPrependPatch(builtInMethod) {
    return function(...nodes) {
      /**
       * A copy of `nodes`, with any DocumentFragment replaced by its children.
       * @type {!Array<!Node>}
       */
      const flattenedNodes = [];

      /**
       * Elements in `nodes` that were connected before this call.
       * @type {!Array<!Node>}
       */
      const connectedElements = [];

      for (var i = 0; i < nodes.length; i++) {
        const node = nodes[i];

        if (node instanceof Element && isConnected(node)) {
          connectedElements.push(node);
        }

        if (node instanceof DocumentFragment) {
          for (let child = node.firstChild; child; child = child.nextSibling) {
            flattenedNodes.push(child);
          }
        } else {
          flattenedNodes.push(node);
        }
      }

      builtInMethod.apply(this, nodes);

      for (let i = 0; i < connectedElements.length; i++) {
        internals.disconnectTree(connectedElements[i]);
      }

      if (isConnected(this)) {
        for (let i = 0; i < flattenedNodes.length; i++) {
          const node = flattenedNodes[i];
          if (node instanceof Element) {
            internals.connectTree(node);
          }
        }
      }
    };
  }

  if (builtIn.prepend !== undefined) {
    setPropertyUnchecked(destination, 'prepend', appendPrependPatch(builtIn.prepend));
  }

  if (builtIn.append !== undefined) {
    setPropertyUnchecked(destination, 'append', appendPrependPatch(builtIn.append));
  }
};

/**
 * @param {!CustomElementInternals} internals
 */
var PatchDocument = function(internals) {
  setPropertyUnchecked(Document.prototype, 'createElement',
    /**
     * @this {Document}
     * @param {string} localName
     * @return {!Element}
     */
    function(localName) {
      // Only create custom elements if this document is associated with the registry.
      if (this.__CE_hasRegistry) {
        const definition = internals.localNameToDefinition(localName);
        if (definition) {
          return new (definition.constructor)();
        }
      }

      const result = /** @type {!Element} */
        (Native.Document_createElement.call(this, localName));
      internals.patch(result);
      return result;
    });

  setPropertyUnchecked(Document.prototype, 'importNode',
    /**
     * @this {Document}
     * @param {!Node} node
     * @param {boolean=} deep
     * @return {!Node}
     */
    function(node, deep) {
      const clone = Native.Document_importNode.call(this, node, deep);
      // Only create custom elements if this document is associated with the registry.
      if (!this.__CE_hasRegistry) {
        internals.patchTree(clone);
      } else {
        internals.patchAndUpgradeTree(clone);
      }
      return clone;
    });

  const NS_HTML = "http://www.w3.org/1999/xhtml";

  setPropertyUnchecked(Document.prototype, 'createElementNS',
    /**
     * @this {Document}
     * @param {?string} namespace
     * @param {string} localName
     * @return {!Element}
     */
    function(namespace, localName) {
      // Only create custom elements if this document is associated with the registry.
      if (this.__CE_hasRegistry && (namespace === null || namespace === NS_HTML)) {
        const definition = internals.localNameToDefinition(localName);
        if (definition) {
          return new (definition.constructor)();
        }
      }

      const result = /** @type {!Element} */
        (Native.Document_createElementNS.call(this, namespace, localName));
      internals.patch(result);
      return result;
    });

  PatchParentNode(internals, Document.prototype, {
    prepend: Native.Document_prepend,
    append: Native.Document_append,
  });
};

/**
 * @param {!CustomElementInternals} internals
 */
var PatchDocumentFragment = function(internals) {
  PatchParentNode(internals, DocumentFragment.prototype, {
    prepend: Native.DocumentFragment_prepend,
    append: Native.DocumentFragment_append,
  });
};

/**
 * @param {!CustomElementInternals} internals
 */
var PatchNode = function(internals) {
  // `Node#nodeValue` is implemented on `Attr`.
  // `Node#textContent` is implemented on `Attr`, `Element`.

  setPropertyUnchecked(Node.prototype, 'insertBefore',
    /**
     * @this {Node}
     * @param {!Node} node
     * @param {?Node} refNode
     * @return {!Node}
     */
    function(node, refNode) {
      if (node instanceof DocumentFragment) {
        const insertedNodes = Array.prototype.slice.apply(node.childNodes);
        const nativeResult = Native.Node_insertBefore.call(this, node, refNode);

        // DocumentFragments can't be connected, so `disconnectTree` will never
        // need to be called on a DocumentFragment's children after inserting it.

        if (isConnected(this)) {
          for (let i = 0; i < insertedNodes.length; i++) {
            internals.connectTree(insertedNodes[i]);
          }
        }

        return nativeResult;
      }

      const nodeWasConnected = isConnected(node);
      const nativeResult = Native.Node_insertBefore.call(this, node, refNode);

      if (nodeWasConnected) {
        internals.disconnectTree(node);
      }

      if (isConnected(this)) {
        internals.connectTree(node);
      }

      return nativeResult;
    });

  setPropertyUnchecked(Node.prototype, 'appendChild',
    /**
     * @this {Node}
     * @param {!Node} node
     * @return {!Node}
     */
    function(node) {
      if (node instanceof DocumentFragment) {
        const insertedNodes = Array.prototype.slice.apply(node.childNodes);
        const nativeResult = Native.Node_appendChild.call(this, node);

        // DocumentFragments can't be connected, so `disconnectTree` will never
        // need to be called on a DocumentFragment's children after inserting it.

        if (isConnected(this)) {
          for (let i = 0; i < insertedNodes.length; i++) {
            internals.connectTree(insertedNodes[i]);
          }
        }

        return nativeResult;
      }

      const nodeWasConnected = isConnected(node);
      const nativeResult = Native.Node_appendChild.call(this, node);

      if (nodeWasConnected) {
        internals.disconnectTree(node);
      }

      if (isConnected(this)) {
        internals.connectTree(node);
      }

      return nativeResult;
    });

  setPropertyUnchecked(Node.prototype, 'cloneNode',
    /**
     * @this {Node}
     * @param {boolean=} deep
     * @return {!Node}
     */
    function(deep) {
      const clone = Native.Node_cloneNode.call(this, deep);
      // Only create custom elements if this element's owner document is
      // associated with the registry.
      if (!this.ownerDocument.__CE_hasRegistry) {
        internals.patchTree(clone);
      } else {
        internals.patchAndUpgradeTree(clone);
      }
      return clone;
    });

  setPropertyUnchecked(Node.prototype, 'removeChild',
    /**
     * @this {Node}
     * @param {!Node} node
     * @return {!Node}
     */
    function(node) {
      const nodeWasConnected = isConnected(node);
      const nativeResult = Native.Node_removeChild.call(this, node);

      if (nodeWasConnected) {
        internals.disconnectTree(node);
      }

      return nativeResult;
    });

  setPropertyUnchecked(Node.prototype, 'replaceChild',
    /**
     * @this {Node}
     * @param {!Node} nodeToInsert
     * @param {!Node} nodeToRemove
     * @return {!Node}
     */
    function(nodeToInsert, nodeToRemove) {
      if (nodeToInsert instanceof DocumentFragment) {
        const insertedNodes = Array.prototype.slice.apply(nodeToInsert.childNodes);
        const nativeResult = Native.Node_replaceChild.call(this, nodeToInsert, nodeToRemove);

        // DocumentFragments can't be connected, so `disconnectTree` will never
        // need to be called on a DocumentFragment's children after inserting it.

        if (isConnected(this)) {
          internals.disconnectTree(nodeToRemove);
          for (let i = 0; i < insertedNodes.length; i++) {
            internals.connectTree(insertedNodes[i]);
          }
        }

        return nativeResult;
      }

      const nodeToInsertWasConnected = isConnected(nodeToInsert);
      const nativeResult = Native.Node_replaceChild.call(this, nodeToInsert, nodeToRemove);
      const thisIsConnected = isConnected(this);

      if (thisIsConnected) {
        internals.disconnectTree(nodeToRemove);
      }

      if (nodeToInsertWasConnected) {
        internals.disconnectTree(nodeToInsert);
      }

      if (thisIsConnected) {
        internals.connectTree(nodeToInsert);
      }

      return nativeResult;
    });


  function patch_textContent(destination, baseDescriptor) {
    Object.defineProperty(destination, 'textContent', {
      enumerable: baseDescriptor.enumerable,
      configurable: true,
      get: baseDescriptor.get,
      set: /** @this {Node} */ function(assignedValue) {
        // If this is a text node then there are no nodes to disconnect.
        if (this.nodeType === Node.TEXT_NODE) {
          baseDescriptor.set.call(this, assignedValue);
          return;
        }

        let removedNodes = undefined;
        // Checking for `firstChild` is faster than reading `childNodes.length`
        // to compare with 0.
        if (this.firstChild) {
          // Using `childNodes` is faster than `children`, even though we only
          // care about elements.
          const childNodes = this.childNodes;
          const childNodesLength = childNodes.length;
          if (childNodesLength > 0 && isConnected(this)) {
            // Copying an array by iterating is faster than using slice.
            removedNodes = new Array(childNodesLength);
            for (let i = 0; i < childNodesLength; i++) {
              removedNodes[i] = childNodes[i];
            }
          }
        }

        baseDescriptor.set.call(this, assignedValue);

        if (removedNodes) {
          for (let i = 0; i < removedNodes.length; i++) {
            internals.disconnectTree(removedNodes[i]);
          }
        }
      },
    });
  }

  if (Native.Node_textContent && Native.Node_textContent.get) {
    patch_textContent(Node.prototype, Native.Node_textContent);
  } else {
    internals.addPatch(function(element) {
      patch_textContent(element, {
        enumerable: true,
        configurable: true,
        // NOTE: This implementation of the `textContent` getter assumes that
        // text nodes' `textContent` getter will not be patched.
        get: /** @this {Node} */ function() {
          /** @type {!Array<string>} */
          const parts = [];

          for (let i = 0; i < this.childNodes.length; i++) {
            parts.push(this.childNodes[i].textContent);
          }

          return parts.join('');
        },
        set: /** @this {Node} */ function(assignedValue) {
          while (this.firstChild) {
            Native.Node_removeChild.call(this, this.firstChild);
          }
          Native.Node_appendChild.call(this, document.createTextNode(assignedValue));
        },
      });
    });
  }
};

/**
 * @param {!CustomElementInternals} internals
 * @param {!Object} destination
 * @param {!ChildNodeNativeMethods} builtIn
 */
var PatchChildNode = function(internals, destination, builtIn) {
  /**
   * @param {!function(...(!Node|string))} builtInMethod
   * @return {!function(...(!Node|string))}
   */
  function beforeAfterPatch(builtInMethod) {
    return function(...nodes) {
      /**
       * A copy of `nodes`, with any DocumentFragment replaced by its children.
       * @type {!Array<!Node>}
       */
      const flattenedNodes = [];

      /**
       * Elements in `nodes` that were connected before this call.
       * @type {!Array<!Node>}
       */
      const connectedElements = [];

      for (var i = 0; i < nodes.length; i++) {
        const node = nodes[i];

        if (node instanceof Element && isConnected(node)) {
          connectedElements.push(node);
        }

        if (node instanceof DocumentFragment) {
          for (let child = node.firstChild; child; child = child.nextSibling) {
            flattenedNodes.push(child);
          }
        } else {
          flattenedNodes.push(node);
        }
      }

      builtInMethod.apply(this, nodes);

      for (let i = 0; i < connectedElements.length; i++) {
        internals.disconnectTree(connectedElements[i]);
      }

      if (isConnected(this)) {
        for (let i = 0; i < flattenedNodes.length; i++) {
          const node = flattenedNodes[i];
          if (node instanceof Element) {
            internals.connectTree(node);
          }
        }
      }
    };
  }

  if (builtIn.before !== undefined) {
    setPropertyUnchecked(destination, 'before', beforeAfterPatch(builtIn.before));
  }

  if (builtIn.before !== undefined) {
    setPropertyUnchecked(destination, 'after', beforeAfterPatch(builtIn.after));
  }

  if (builtIn.replaceWith !== undefined) {
    setPropertyUnchecked(destination, 'replaceWith',
      /**
       * @param {...(!Node|string)} nodes
       */
      function(...nodes) {
        /**
         * A copy of `nodes`, with any DocumentFragment replaced by its children.
         * @type {!Array<!Node>}
         */
        const flattenedNodes = [];

        /**
         * Elements in `nodes` that were connected before this call.
         * @type {!Array<!Node>}
         */
        const connectedElements = [];

        for (var i = 0; i < nodes.length; i++) {
          const node = nodes[i];

          if (node instanceof Element && isConnected(node)) {
            connectedElements.push(node);
          }

          if (node instanceof DocumentFragment) {
            for (let child = node.firstChild; child; child = child.nextSibling) {
              flattenedNodes.push(child);
            }
          } else {
            flattenedNodes.push(node);
          }
        }

        const wasConnected = isConnected(this);

        builtIn.replaceWith.apply(this, nodes);

        for (let i = 0; i < connectedElements.length; i++) {
          internals.disconnectTree(connectedElements[i]);
        }

        if (wasConnected) {
          internals.disconnectTree(this);
          for (let i = 0; i < flattenedNodes.length; i++) {
            const node = flattenedNodes[i];
            if (node instanceof Element) {
              internals.connectTree(node);
            }
          }
        }
      });
    }

  if (builtIn.remove !== undefined) {
    setPropertyUnchecked(destination, 'remove',
      function() {
        const wasConnected = isConnected(this);

        builtIn.remove.call(this);

        if (wasConnected) {
          internals.disconnectTree(this);
        }
      });
  }
};

/**
 * @param {!CustomElementInternals} internals
 */
var PatchElement = function(internals) {
  if (Native.Element_attachShadow) {
    setPropertyUnchecked(Element.prototype, 'attachShadow',
      /**
       * @this {Element}
       * @param {!{mode: string}} init
       * @return {ShadowRoot}
       */
      function(init) {
        const shadowRoot = Native.Element_attachShadow.call(this, init);
        this.__CE_shadowRoot = shadowRoot;
        return shadowRoot;
      });
  }


  function patch_innerHTML(destination, baseDescriptor) {
    Object.defineProperty(destination, 'innerHTML', {
      enumerable: baseDescriptor.enumerable,
      configurable: true,
      get: baseDescriptor.get,
      set: /** @this {Element} */ function(htmlString) {
        const isConnected$$1 = isConnected(this);

        // NOTE: In IE11, when using the native `innerHTML` setter, all nodes
        // that were previously descendants of the context element have all of
        // their children removed as part of the set - the entire subtree is
        // 'disassembled'. This work around walks the subtree *before* using the
        // native setter.
        /** @type {!Array<!Element>|undefined} */
        let removedElements = undefined;
        if (isConnected$$1) {
          removedElements = [];
          walkDeepDescendantElements(this, element => {
            if (element !== this) {
              removedElements.push(element);
            }
          });
        }

        baseDescriptor.set.call(this, htmlString);

        if (removedElements) {
          for (let i = 0; i < removedElements.length; i++) {
            const element = removedElements[i];
            if (element.__CE_state === CustomElementState.custom) {
              internals.disconnectedCallback(element);
            }
          }
        }

        // Only create custom elements if this element's owner document is
        // associated with the registry.
        if (!this.ownerDocument.__CE_hasRegistry) {
          internals.patchTree(this);
        } else {
          internals.patchAndUpgradeTree(this);
        }
        return htmlString;
      },
    });
  }

  if (Native.Element_innerHTML && Native.Element_innerHTML.get) {
    patch_innerHTML(Element.prototype, Native.Element_innerHTML);
  } else if (Native.HTMLElement_innerHTML && Native.HTMLElement_innerHTML.get) {
    patch_innerHTML(HTMLElement.prototype, Native.HTMLElement_innerHTML);
  } else {

    internals.addPatch(function(element) {
      patch_innerHTML(element, {
        enumerable: true,
        configurable: true,
        // Implements getting `innerHTML` by performing an unpatched `cloneNode`
        // of the element and returning the resulting element's `innerHTML`.
        // TODO: Is this too expensive?
        get: /** @this {Element} */ function() {
          return Native.Node_cloneNode.call(this, true).innerHTML;
        },
        // Implements setting `innerHTML` by creating an unpatched element,
        // setting `innerHTML` of that element and replacing the target
        // element's children with those of the unpatched element.
        set: /** @this {Element} */ function(assignedValue) {
          // NOTE: re-route to `content` for `template` elements.
          // We need to do this because `template.appendChild` does not
          // route into `template.content`.
          const isTemplate = (this.localName === 'template');
          /** @type {!Node} */
          const content = isTemplate ? (/** @type {!HTMLTemplateElement} */
            (this)).content : this;
          /** @type {!Node} */
          const rawElement = Native.Document_createElement.call(document,
            this.localName);
          rawElement.innerHTML = assignedValue;

          while (content.childNodes.length > 0) {
            Native.Node_removeChild.call(content, content.childNodes[0]);
          }
          const container = isTemplate ? rawElement.content : rawElement;
          while (container.childNodes.length > 0) {
            Native.Node_appendChild.call(content, container.childNodes[0]);
          }
        },
      });
    });
  }


  setPropertyUnchecked(Element.prototype, 'setAttribute',
    /**
     * @this {Element}
     * @param {string} name
     * @param {string} newValue
     */
    function(name, newValue) {
      // Fast path for non-custom elements.
      if (this.__CE_state !== CustomElementState.custom) {
        return Native.Element_setAttribute.call(this, name, newValue);
      }

      const oldValue = Native.Element_getAttribute.call(this, name);
      Native.Element_setAttribute.call(this, name, newValue);
      newValue = Native.Element_getAttribute.call(this, name);
      internals.attributeChangedCallback(this, name, oldValue, newValue, null);
    });

  setPropertyUnchecked(Element.prototype, 'setAttributeNS',
    /**
     * @this {Element}
     * @param {?string} namespace
     * @param {string} name
     * @param {string} newValue
     */
    function(namespace, name, newValue) {
      // Fast path for non-custom elements.
      if (this.__CE_state !== CustomElementState.custom) {
        return Native.Element_setAttributeNS.call(this, namespace, name, newValue);
      }

      const oldValue = Native.Element_getAttributeNS.call(this, namespace, name);
      Native.Element_setAttributeNS.call(this, namespace, name, newValue);
      newValue = Native.Element_getAttributeNS.call(this, namespace, name);
      internals.attributeChangedCallback(this, name, oldValue, newValue, namespace);
    });

  setPropertyUnchecked(Element.prototype, 'removeAttribute',
    /**
     * @this {Element}
     * @param {string} name
     */
    function(name) {
      // Fast path for non-custom elements.
      if (this.__CE_state !== CustomElementState.custom) {
        return Native.Element_removeAttribute.call(this, name);
      }

      const oldValue = Native.Element_getAttribute.call(this, name);
      Native.Element_removeAttribute.call(this, name);
      if (oldValue !== null) {
        internals.attributeChangedCallback(this, name, oldValue, null, null);
      }
    });

  setPropertyUnchecked(Element.prototype, 'removeAttributeNS',
    /**
     * @this {Element}
     * @param {?string} namespace
     * @param {string} name
     */
    function(namespace, name) {
      // Fast path for non-custom elements.
      if (this.__CE_state !== CustomElementState.custom) {
        return Native.Element_removeAttributeNS.call(this, namespace, name);
      }

      const oldValue = Native.Element_getAttributeNS.call(this, namespace, name);
      Native.Element_removeAttributeNS.call(this, namespace, name);
      // In older browsers, `Element#getAttributeNS` may return the empty string
      // instead of null if the attribute does not exist. For details, see;
      // https://developer.mozilla.org/en-US/docs/Web/API/Element/getAttributeNS#Notes
      const newValue = Native.Element_getAttributeNS.call(this, namespace, name);
      if (oldValue !== newValue) {
        internals.attributeChangedCallback(this, name, oldValue, newValue, namespace);
      }
    });


  function patch_insertAdjacentElement(destination, baseMethod) {
    setPropertyUnchecked(destination, 'insertAdjacentElement',
      /**
       * @this {Element}
       * @param {string} where
       * @param {!Element} element
       * @return {?Element}
       */
      function(where, element) {
        const wasConnected = isConnected(element);
        const insertedElement = /** @type {!Element} */
          (baseMethod.call(this, where, element));

        if (wasConnected) {
          internals.disconnectTree(element);
        }

        if (isConnected(insertedElement)) {
          internals.connectTree(element);
        }
        return insertedElement;
      });
  }

  if (Native.HTMLElement_insertAdjacentElement) {
    patch_insertAdjacentElement(HTMLElement.prototype, Native.HTMLElement_insertAdjacentElement);
  } else if (Native.Element_insertAdjacentElement) {
    patch_insertAdjacentElement(Element.prototype, Native.Element_insertAdjacentElement);
  } else {
    console.warn('Custom Elements: `Element#insertAdjacentElement` was not patched.');
  }


  PatchParentNode(internals, Element.prototype, {
    prepend: Native.Element_prepend,
    append: Native.Element_append,
  });

  PatchChildNode(internals, Element.prototype, {
    before: Native.Element_before,
    after: Native.Element_after,
    replaceWith: Native.Element_replaceWith,
    remove: Native.Element_remove,
  });
};

/**
 * @license
 * Copyright (c) 2016 The Polymer Project Authors. All rights reserved.
 * This code may only be used under the BSD style license found at http://polymer.github.io/LICENSE.txt
 * The complete set of authors may be found at http://polymer.github.io/AUTHORS.txt
 * The complete set of contributors may be found at http://polymer.github.io/CONTRIBUTORS.txt
 * Code distributed by Google as part of the polymer project is also
 * subject to an additional IP rights grant found at http://polymer.github.io/PATENTS.txt
 */

const priorCustomElements = window['customElements'];

if (!priorCustomElements ||
     priorCustomElements['forcePolyfill'] ||
     (typeof priorCustomElements['define'] != 'function') ||
     (typeof priorCustomElements['get'] != 'function')) {
  /** @type {!CustomElementInternals} */
  const internals = new CustomElementInternals();

  PatchHTMLElement(internals);
  PatchDocument(internals);
  PatchDocumentFragment(internals);
  PatchNode(internals);
  PatchElement(internals);

  // The main document is always associated with the registry.
  document.__CE_hasRegistry = true;

  /** @type {!CustomElementRegistry} */
  const customElements = new CustomElementRegistry(internals);

  Object.defineProperty(window, 'customElements', {
    configurable: true,
    enumerable: true,
    value: customElements,
  });
}

/**
@license
Copyright (c) 2017 The Polymer Project Authors. All rights reserved.
This code may only be used under the BSD style license found at http://polymer.github.io/LICENSE.txt
The complete set of authors may be found at http://polymer.github.io/AUTHORS.txt
The complete set of contributors may be found at http://polymer.github.io/CONTRIBUTORS.txt
Code distributed by Google as part of the polymer project is also
subject to an additional IP rights grant found at http://polymer.github.io/PATENTS.txt
*/

/*
Extremely simple css parser. Intended to be not more than what we need
and definitely not necessarily correct =).
*/

/** @unrestricted */
class StyleNode {
  constructor() {
    /** @type {number} */
    this['start'] = 0;
    /** @type {number} */
    this['end'] = 0;
    /** @type {StyleNode} */
    this['previous'] = null;
    /** @type {StyleNode} */
    this['parent'] = null;
    /** @type {Array<StyleNode>} */
    this['rules'] = null;
    /** @type {string} */
    this['parsedCssText'] = '';
    /** @type {string} */
    this['cssText'] = '';
    /** @type {boolean} */
    this['atRule'] = false;
    /** @type {number} */
    this['type'] = 0;
    /** @type {string} */
    this['keyframesName'] = '';
    /** @type {string} */
    this['selector'] = '';
    /** @type {string} */
    this['parsedSelector'] = '';
  }
}

// given a string of css, return a simple rule tree
/**
 * @param {string} text
 * @return {StyleNode}
 */
function parse(text) {
  text = clean(text);
  return parseCss(lex(text), text);
}

// remove stuff we don't care about that may hinder parsing
/**
 * @param {string} cssText
 * @return {string}
 */
function clean(cssText) {
  return cssText.replace(RX.comments, '').replace(RX.port, '');
}

// super simple {...} lexer that returns a node tree
/**
 * @param {string} text
 * @return {StyleNode}
 */
function lex(text) {
  let root = new StyleNode();
  root['start'] = 0;
  root['end'] = text.length;
  let n = root;
  for (let i = 0, l = text.length; i < l; i++) {
    if (text[i] === OPEN_BRACE) {
      if (!n['rules']) {
        n['rules'] = [];
      }
      let p = n;
      let previous = p['rules'][p['rules'].length - 1] || null;
      n = new StyleNode();
      n['start'] = i + 1;
      n['parent'] = p;
      n['previous'] = previous;
      p['rules'].push(n);
    } else if (text[i] === CLOSE_BRACE) {
      n['end'] = i + 1;
      n = n['parent'] || root;
    }
  }
  return root;
}

// add selectors/cssText to node tree
/**
 * @param {StyleNode} node
 * @param {string} text
 * @return {StyleNode}
 */
function parseCss(node, text) {
  let t = text.substring(node['start'], node['end'] - 1);
  node['parsedCssText'] = node['cssText'] = t.trim();
  if (node['parent']) {
    let ss = node['previous'] ? node['previous']['end'] : node['parent']['start'];
    t = text.substring(ss, node['start'] - 1);
    t = _expandUnicodeEscapes(t);
    t = t.replace(RX.multipleSpaces, ' ');
    // TODO(sorvell): ad hoc; make selector include only after last ;
    // helps with mixin syntax
    t = t.substring(t.lastIndexOf(';') + 1);
    let s = node['parsedSelector'] = node['selector'] = t.trim();
    node['atRule'] = (s.indexOf(AT_START) === 0);
    // note, support a subset of rule types...
    if (node['atRule']) {
      if (s.indexOf(MEDIA_START) === 0) {
        node['type'] = types.MEDIA_RULE;
      } else if (s.match(RX.keyframesRule)) {
        node['type'] = types.KEYFRAMES_RULE;
        node['keyframesName'] =
          node['selector'].split(RX.multipleSpaces).pop();
      }
    } else {
      if (s.indexOf(VAR_START) === 0) {
        node['type'] = types.MIXIN_RULE;
      } else {
        node['type'] = types.STYLE_RULE;
      }
    }
  }
  let r$ = node['rules'];
  if (r$) {
    for (let i = 0, l = r$.length, r;
      (i < l) && (r = r$[i]); i++) {
      parseCss(r, text);
    }
  }
  return node;
}

/**
 * conversion of sort unicode escapes with spaces like `\33 ` (and longer) into
 * expanded form that doesn't require trailing space `\000033`
 * @param {string} s
 * @return {string}
 */
function _expandUnicodeEscapes(s) {
  return s.replace(/\\([0-9a-f]{1,6})\s/gi, function() {
    let code = arguments[1],
      repeat = 6 - code.length;
    while (repeat--) {
      code = '0' + code;
    }
    return '\\' + code;
  });
}

/**
 * stringify parsed css.
 * @param {StyleNode} node
 * @param {boolean=} preserveProperties
 * @param {string=} text
 * @return {string}
 */
function stringify(node, preserveProperties, text = '') {
  // calc rule cssText
  let cssText = '';
  if (node['cssText'] || node['rules']) {
    let r$ = node['rules'];
    if (r$ && !_hasMixinRules(r$)) {
      for (let i = 0, l = r$.length, r;
        (i < l) && (r = r$[i]); i++) {
        cssText = stringify(r, preserveProperties, cssText);
      }
    } else {
      cssText = preserveProperties ? node['cssText'] :
        removeCustomProps(node['cssText']);
      cssText = cssText.trim();
      if (cssText) {
        cssText = '  ' + cssText + '\n';
      }
    }
  }
  // emit rule if there is cssText
  if (cssText) {
    if (node['selector']) {
      text += node['selector'] + ' ' + OPEN_BRACE + '\n';
    }
    text += cssText;
    if (node['selector']) {
      text += CLOSE_BRACE + '\n\n';
    }
  }
  return text;
}

/**
 * @param {Array<StyleNode>} rules
 * @return {boolean}
 */
function _hasMixinRules(rules) {
  let r = rules[0];
  return Boolean(r) && Boolean(r['selector']) && r['selector'].indexOf(VAR_START) === 0;
}

/**
 * @param {string} cssText
 * @return {string}
 */
function removeCustomProps(cssText) {
  cssText = removeCustomPropAssignment(cssText);
  return removeCustomPropApply(cssText);
}

/**
 * @param {string} cssText
 * @return {string}
 */
function removeCustomPropAssignment(cssText) {
  return cssText
    .replace(RX.customProp, '')
    .replace(RX.mixinProp, '');
}

/**
 * @param {string} cssText
 * @return {string}
 */
function removeCustomPropApply(cssText) {
  return cssText
    .replace(RX.mixinApply, '')
    .replace(RX.varApply, '');
}

/** @enum {number} */
const types = {
  STYLE_RULE: 1,
  KEYFRAMES_RULE: 7,
  MEDIA_RULE: 4,
  MIXIN_RULE: 1000
};

const OPEN_BRACE = '{';
const CLOSE_BRACE = '}';

// helper regexp's
const RX = {
  comments: /\/\*[^*]*\*+([^/*][^*]*\*+)*\//gim,
  port: /@import[^;]*;/gim,
  customProp: /(?:^[^;\-\s}]+)?--[^;{}]*?:[^{};]*?(?:[;\n]|$)/gim,
  mixinProp: /(?:^[^;\-\s}]+)?--[^;{}]*?:[^{};]*?{[^}]*?}(?:[;\n]|$)?/gim,
  mixinApply: /@apply\s*\(?[^);]*\)?\s*(?:[;\n]|$)?/gim,
  varApply: /[^;:]*?:[^;]*?var\([^;]*\)(?:[;\n]|$)?/gim,
  keyframesRule: /^@[^\s]*keyframes/,
  multipleSpaces: /\s+/g
};

const VAR_START = '--';
const MEDIA_START = '@media';
const AT_START = '@';

/**
@license
Copyright (c) 2017 The Polymer Project Authors. All rights reserved.
This code may only be used under the BSD style license found at http://polymer.github.io/LICENSE.txt
The complete set of authors may be found at http://polymer.github.io/AUTHORS.txt
The complete set of contributors may be found at http://polymer.github.io/CONTRIBUTORS.txt
Code distributed by Google as part of the polymer project is also
subject to an additional IP rights grant found at http://polymer.github.io/PATENTS.txt
*/

let nativeShadow = !(window['ShadyDOM'] && window['ShadyDOM']['inUse']);
let nativeCssVariables;

/**
 * @param {(ShadyCSSOptions | ShadyCSSInterface)=} settings
 */
function calcCssVariables(settings) {
  if (settings && settings['shimcssproperties']) {
    nativeCssVariables = false;
  } else {
    // chrome 49 has semi-working css vars, check if box-shadow works
    // safari 9.1 has a recalc bug: https://bugs.webkit.org/show_bug.cgi?id=155782
    // However, shim css custom properties are only supported with ShadyDOM enabled,
    // so fall back on native if we do not detect ShadyDOM
    // Edge 15: custom properties used in ::before and ::after will also be used in the parent element
    // https://developer.microsoft.com/en-us/microsoft-edge/platform/issues/12414257/
    nativeCssVariables = nativeShadow || Boolean(!navigator.userAgent.match(/AppleWebKit\/601|Edge\/15/) &&
      window.CSS && CSS.supports && CSS.supports('box-shadow', '0 0 0 var(--foo)'));
  }
}

if (window.ShadyCSS && window.ShadyCSS.nativeCss !== undefined) {
  nativeCssVariables = window.ShadyCSS.nativeCss;
} else if (window.ShadyCSS) {
  calcCssVariables(window.ShadyCSS);
  // reset window variable to let ShadyCSS API take its place
  window.ShadyCSS = undefined;
} else {
  calcCssVariables(window['WebComponents'] && window['WebComponents']['flags']);
}

/**
@license
Copyright (c) 2017 The Polymer Project Authors. All rights reserved.
This code may only be used under the BSD style license found at http://polymer.github.io/LICENSE.txt
The complete set of authors may be found at http://polymer.github.io/AUTHORS.txt
The complete set of contributors may be found at http://polymer.github.io/CONTRIBUTORS.txt
Code distributed by Google as part of the polymer project is also
subject to an additional IP rights grant found at http://polymer.github.io/PATENTS.txt
*/

const VAR_ASSIGN = /(?:^|[;\s{]\s*)(--[\w-]*?)\s*:\s*(?:((?:'(?:\\'|.)*?'|"(?:\\"|.)*?"|\([^)]*?\)|[^};{])+)|\{([^}]*)\}(?:(?=[;\s}])|$))/gi;
const MIXIN_MATCH = /(?:^|\W+)@apply\s*\(?([^);\n]*)\)?/gi;
const VAR_CONSUMED = /(--[\w-]+)\s*([:,;)]|$)/gi;
const ANIMATION_MATCH = /(animation\s*:)|(animation-name\s*:)/;
const MEDIA_MATCH = /@media\s(.*)/;

const BRACKETED = /\{[^}]*\}/g;
const HOST_PREFIX = '(?:^|[^.#[:])';
const HOST_SUFFIX = '($|[.:[\\s>+~])';

/**
@license
Copyright (c) 2017 The Polymer Project Authors. All rights reserved.
This code may only be used under the BSD style license found at http://polymer.github.io/LICENSE.txt
The complete set of authors may be found at http://polymer.github.io/AUTHORS.txt
The complete set of contributors may be found at http://polymer.github.io/CONTRIBUTORS.txt
Code distributed by Google as part of the polymer project is also
subject to an additional IP rights grant found at http://polymer.github.io/PATENTS.txt
*/

/** @type {!Set<string>} */
const styleTextSet = new Set();

const scopingAttribute = 'shady-unscoped';

/**
 * Add a specifically-marked style to the document directly, and only one copy of that style.
 *
 * @param {!HTMLStyleElement} style
 * @return {undefined}
 */
function processUnscopedStyle(style) {
  const text = style.textContent;
  if (!styleTextSet.has(text)) {
    styleTextSet.add(text);
    const newStyle = style.cloneNode(true);
    document.head.appendChild(newStyle);
  }
}

/**
 * Check if a style is supposed to be unscoped
 * @param {!HTMLStyleElement} style
 * @return {boolean} true if the style has the unscoping attribute
 */
function isUnscopedStyle(style) {
  return style.hasAttribute(scopingAttribute);
}

/**
@license
Copyright (c) 2017 The Polymer Project Authors. All rights reserved.
This code may only be used under the BSD style license found at http://polymer.github.io/LICENSE.txt
The complete set of authors may be found at http://polymer.github.io/AUTHORS.txt
The complete set of contributors may be found at http://polymer.github.io/CONTRIBUTORS.txt
Code distributed by Google as part of the polymer project is also
subject to an additional IP rights grant found at http://polymer.github.io/PATENTS.txt
*/

/**
 * @param {string|StyleNode} rules
 * @param {function(StyleNode)=} callback
 * @return {string}
 */
function toCssText (rules, callback) {
  if (!rules) {
    return '';
  }
  if (typeof rules === 'string') {
    rules = parse(rules);
  }
  if (callback) {
    forEachRule(rules, callback);
  }
  return stringify(rules, nativeCssVariables);
}

/**
 * @param {HTMLStyleElement} style
 * @return {StyleNode}
 */
function rulesForStyle(style) {
  if (!style['__cssRules'] && style.textContent) {
    style['__cssRules'] = parse(style.textContent);
  }
  return style['__cssRules'] || null;
}

// Tests if a rule is a keyframes selector, which looks almost exactly
// like a normal selector but is not (it has nothing to do with scoping
// for example).
/**
 * @param {StyleNode} rule
 * @return {boolean}
 */
function isKeyframesSelector(rule) {
  return Boolean(rule['parent']) &&
  rule['parent']['type'] === types.KEYFRAMES_RULE;
}

/**
 * @param {StyleNode} node
 * @param {Function=} styleRuleCallback
 * @param {Function=} keyframesRuleCallback
 * @param {boolean=} onlyActiveRules
 */
function forEachRule(node, styleRuleCallback, keyframesRuleCallback, onlyActiveRules) {
  if (!node) {
    return;
  }
  let skipRules = false;
  let type = node['type'];
  if (onlyActiveRules) {
    if (type === types.MEDIA_RULE) {
      let matchMedia = node['selector'].match(MEDIA_MATCH);
      if (matchMedia) {
        // if rule is a non matching @media rule, skip subrules
        if (!window.matchMedia(matchMedia[1]).matches) {
          skipRules = true;
        }
      }
    }
  }
  if (type === types.STYLE_RULE) {
    styleRuleCallback(node);
  } else if (keyframesRuleCallback &&
    type === types.KEYFRAMES_RULE) {
    keyframesRuleCallback(node);
  } else if (type === types.MIXIN_RULE) {
    skipRules = true;
  }
  let r$ = node['rules'];
  if (r$ && !skipRules) {
    for (let i=0, l=r$.length, r; (i<l) && (r=r$[i]); i++) {
      forEachRule(r, styleRuleCallback, keyframesRuleCallback, onlyActiveRules);
    }
  }
}

// add a string of cssText to the document.
/**
 * @param {string} cssText
 * @param {string} moniker
 * @param {Node} target
 * @param {Node} contextNode
 * @return {HTMLStyleElement}
 */
function applyCss(cssText, moniker, target, contextNode) {
  let style = createScopeStyle(cssText, moniker);
  applyStyle(style, target, contextNode);
  return style;
}

/**
 * @param {string} cssText
 * @param {string} moniker
 * @return {HTMLStyleElement}
 */
function createScopeStyle(cssText, moniker) {
  let style = /** @type {HTMLStyleElement} */(document.createElement('style'));
  if (moniker) {
    style.setAttribute('scope', moniker);
  }
  style.textContent = cssText;
  return style;
}

/**
 * Track the position of the last added style for placing placeholders
 * @type {Node}
 */
let lastHeadApplyNode = null;

// insert a comment node as a styling position placeholder.
/**
 * @param {string} moniker
 * @return {!Comment}
 */
function applyStylePlaceHolder(moniker) {
  let placeHolder = document.createComment(' Shady DOM styles for ' +
    moniker + ' ');
  let after = lastHeadApplyNode ?
    lastHeadApplyNode['nextSibling'] : null;
  let scope = document.head;
  scope.insertBefore(placeHolder, after || scope.firstChild);
  lastHeadApplyNode = placeHolder;
  return placeHolder;
}

/**
 * @param {HTMLStyleElement} style
 * @param {?Node} target
 * @param {?Node} contextNode
 */
function applyStyle(style, target, contextNode) {
  target = target || document.head;
  let after = (contextNode && contextNode.nextSibling) ||
    target.firstChild;
  target.insertBefore(style, after);
  if (!lastHeadApplyNode) {
    lastHeadApplyNode = style;
  } else {
    // only update lastHeadApplyNode if the new style is inserted after the old lastHeadApplyNode
    let position = style.compareDocumentPosition(lastHeadApplyNode);
    if (position === Node.DOCUMENT_POSITION_PRECEDING) {
      lastHeadApplyNode = style;
    }
  }
}

/**
 * @param {string} buildType
 * @return {boolean}
 */


/**
 * @param {Element} element
 * @return {?string}
 */


/**
 * Walk from text[start] matching parens and
 * returns position of the outer end paren
 * @param {string} text
 * @param {number} start
 * @return {number}
 */
function findMatchingParen(text, start) {
  let level = 0;
  for (let i=start, l=text.length; i < l; i++) {
    if (text[i] === '(') {
      level++;
    } else if (text[i] === ')') {
      if (--level === 0) {
        return i;
      }
    }
  }
  return -1;
}

/**
 * @param {string} str
 * @param {function(string, string, string, string)} callback
 */
function processVariableAndFallback(str, callback) {
  // find 'var('
  let start = str.indexOf('var(');
  if (start === -1) {
    // no var?, everything is prefix
    return callback(str, '', '', '');
  }
  //${prefix}var(${inner})${suffix}
  let end = findMatchingParen(str, start + 3);
  let inner = str.substring(start + 4, end);
  let prefix = str.substring(0, start);
  // suffix may have other variables
  let suffix = processVariableAndFallback(str.substring(end + 1), callback);
  let comma = inner.indexOf(',');
  // value and fallback args should be trimmed to match in property lookup
  if (comma === -1) {
    // variable, no fallback
    return callback(prefix, inner.trim(), '', suffix);
  }
  // var(${value},${fallback})
  let value = inner.substring(0, comma).trim();
  let fallback = inner.substring(comma + 1).trim();
  return callback(prefix, value, fallback, suffix);
}

/**
 * @param {Element} element
 * @param {string} value
 */
function setElementClassRaw(element, value) {
  // use native setAttribute provided by ShadyDOM when setAttribute is patched
  if (nativeShadow) {
    element.setAttribute('class', value);
  } else {
    window['ShadyDOM']['nativeMethods']['setAttribute'].call(element, 'class', value);
  }
}

/**
 * @param {Element | {is: string, extends: string}} element
 * @return {{is: string, typeExtension: string}}
 */
function getIsExtends(element) {
  let localName = element['localName'];
  let is = '', typeExtension = '';
  /*
  NOTE: technically, this can be wrong for certain svg elements
  with `-` in the name like `<font-face>`
  */
  if (localName) {
    if (localName.indexOf('-') > -1) {
      is = localName;
    } else {
      typeExtension = localName;
      is = (element.getAttribute && element.getAttribute('is')) || '';
    }
  } else {
    is = /** @type {?} */(element).is;
    typeExtension = /** @type {?} */(element).extends;
  }
  return {is, typeExtension};
}

/**
 * @param {Element|DocumentFragment} element
 * @return {string}
 */
function gatherStyleText(element) {
  /** @type {!Array<string>} */
  const styleTextParts = [];
  const styles = /** @type {!NodeList<!HTMLStyleElement>} */(element.querySelectorAll('style'));
  for (let i = 0; i < styles.length; i++) {
    const style = styles[i];
    if (isUnscopedStyle(style)) {
      if (!nativeShadow) {
        processUnscopedStyle(style);
        style.parentNode.removeChild(style);
      }
    } else {
      styleTextParts.push(style.textContent);
      style.parentNode.removeChild(style);
    }
  }
  return styleTextParts.join('').trim();
}

/**
@license
Copyright (c) 2017 The Polymer Project Authors. All rights reserved.
This code may only be used under the BSD style license found at http://polymer.github.io/LICENSE.txt
The complete set of authors may be found at http://polymer.github.io/AUTHORS.txt
The complete set of contributors may be found at http://polymer.github.io/CONTRIBUTORS.txt
Code distributed by Google as part of the polymer project is also
subject to an additional IP rights grant found at http://polymer.github.io/PATENTS.txt
*/

/* Transforms ShadowDOM styling into ShadyDOM styling

* scoping:

  * elements in scope get scoping selector class="x-foo-scope"
  * selectors re-written as follows:

    div button -> div.x-foo-scope button.x-foo-scope

* :host -> scopeName

* :host(...) -> scopeName...

* ::slotted(...) -> scopeName > ...

* ...:dir(ltr|rtl) -> [dir="ltr|rtl"] ..., ...[dir="ltr|rtl"]

* :host(:dir[rtl]) -> scopeName:dir(rtl) -> [dir="rtl"] scopeName, scopeName[dir="rtl"]

*/
const SCOPE_NAME = 'style-scope';

class StyleTransformer {
  get SCOPE_NAME() {
    return SCOPE_NAME;
  }
  // Given a node and scope name, add a scoping class to each node
  // in the tree. This facilitates transforming css into scoped rules.
  dom(node, scope, shouldRemoveScope) {
    // one time optimization to skip scoping...
    if (node['__styleScoped']) {
      node['__styleScoped'] = null;
    } else {
      this._transformDom(node, scope || '', shouldRemoveScope);
    }
  }

  _transformDom(node, selector, shouldRemoveScope) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      this.element(node, selector, shouldRemoveScope);
    }
    let c$ = (node.localName === 'template') ?
      (node.content || node._content).childNodes :
      node.children || node.childNodes;
    if (c$) {
      for (let i=0; i<c$.length; i++) {
        this._transformDom(c$[i], selector, shouldRemoveScope);
      }
    }
  }

  element(element, scope, shouldRemoveScope) {
    // note: if using classes, we add both the general 'style-scope' class
    // as well as the specific scope. This enables easy filtering of all
    // `style-scope` elements
    if (scope) {
      // note: svg on IE does not have classList so fallback to class
      if (element.classList) {
        if (shouldRemoveScope) {
          element.classList.remove(SCOPE_NAME);
          element.classList.remove(scope);
        } else {
          element.classList.add(SCOPE_NAME);
          element.classList.add(scope);
        }
      } else if (element.getAttribute) {
        let c = element.getAttribute(CLASS);
        if (shouldRemoveScope) {
          if (c) {
            let newValue = c.replace(SCOPE_NAME, '').replace(scope, '');
            setElementClassRaw(element, newValue);
          }
        } else {
          let newValue = (c ? c + ' ' : '') + SCOPE_NAME + ' ' + scope;
          setElementClassRaw(element, newValue);
        }
      }
    }
  }

  elementStyles(element, styleRules, callback) {
    let cssBuildType = element['__cssBuild'];
    // no need to shim selectors if settings.useNativeShadow, also
    // a shady css build will already have transformed selectors
    // NOTE: This method may be called as part of static or property shimming.
    // When there is a targeted build it will not be called for static shimming,
    // but when the property shim is used it is called and should opt out of
    // static shimming work when a proper build exists.
    let cssText = '';
    if (nativeShadow || cssBuildType === 'shady') {
      cssText = toCssText(styleRules, callback);
    } else {
      let {is, typeExtension} = getIsExtends(element);
      cssText = this.css(styleRules, is, typeExtension, callback) + '\n\n';
    }
    return cssText.trim();
  }

  // Given a string of cssText and a scoping string (scope), returns
  // a string of scoped css where each selector is transformed to include
  // a class created from the scope. ShadowDOM selectors are also transformed
  // (e.g. :host) to use the scoping selector.
  css(rules, scope, ext, callback) {
    let hostScope = this._calcHostScope(scope, ext);
    scope = this._calcElementScope(scope);
    let self = this;
    return toCssText(rules, function(/** StyleNode */rule) {
      if (!rule.isScoped) {
        self.rule(rule, scope, hostScope);
        rule.isScoped = true;
      }
      if (callback) {
        callback(rule, scope, hostScope);
      }
    });
  }

  _calcElementScope(scope) {
    if (scope) {
      return CSS_CLASS_PREFIX + scope;
    } else {
      return '';
    }
  }

  _calcHostScope(scope, ext) {
    return ext ? `[is=${scope}]` : scope;
  }

  rule(rule, scope, hostScope) {
    this._transformRule(rule, this._transformComplexSelector,
      scope, hostScope);
  }

  /**
   * transforms a css rule to a scoped rule.
   *
   * @param {StyleNode} rule
   * @param {Function} transformer
   * @param {string=} scope
   * @param {string=} hostScope
   */
  _transformRule(rule, transformer, scope, hostScope) {
    // NOTE: save transformedSelector for subsequent matching of elements
    // against selectors (e.g. when calculating style properties)
    rule['selector'] = rule.transformedSelector =
      this._transformRuleCss(rule, transformer, scope, hostScope);
  }

  /**
   * @param {StyleNode} rule
   * @param {Function} transformer
   * @param {string=} scope
   * @param {string=} hostScope
   */
  _transformRuleCss(rule, transformer, scope, hostScope) {
    let p$ = rule['selector'].split(COMPLEX_SELECTOR_SEP);
    // we want to skip transformation of rules that appear in keyframes,
    // because they are keyframe selectors, not element selectors.
    if (!isKeyframesSelector(rule)) {
      for (let i=0, l=p$.length, p; (i<l) && (p=p$[i]); i++) {
        p$[i] = transformer.call(this, p, scope, hostScope);
      }
    }
    return p$.join(COMPLEX_SELECTOR_SEP);
  }

  /**
   * @param {string} selector
   * @return {string}
   */
  _twiddleNthPlus(selector) {
    return selector.replace(NTH, (m, type, inside) => {
      if (inside.indexOf('+') > -1) {
        inside = inside.replace(/\+/g, '___');
      } else if (inside.indexOf('___') > -1) {
        inside = inside.replace(/___/g, '+');
      }
      return `:${type}(${inside})`;
    });
  }

/**
 * @param {string} selector
 * @param {string} scope
 * @param {string=} hostScope
 */
  _transformComplexSelector(selector, scope, hostScope) {
    let stop = false;
    selector = selector.trim();
    // Remove spaces inside of selectors like `:nth-of-type` because it confuses SIMPLE_SELECTOR_SEP
    let isNth = NTH.test(selector);
    if (isNth) {
      selector = selector.replace(NTH, (m, type, inner) => `:${type}(${inner.replace(/\s/g, '')})`);
      selector = this._twiddleNthPlus(selector);
    }
    selector = selector.replace(SLOTTED_START, `${HOST} $1`);
    selector = selector.replace(SIMPLE_SELECTOR_SEP, (m, c, s) => {
      if (!stop) {
        let info = this._transformCompoundSelector(s, c, scope, hostScope);
        stop = stop || info.stop;
        c = info.combinator;
        s = info.value;
      }
      return c + s;
    });
    if (isNth) {
      selector = this._twiddleNthPlus(selector);
    }
    return selector;
  }

  _transformCompoundSelector(selector, combinator, scope, hostScope) {
    // replace :host with host scoping class
    let slottedIndex = selector.indexOf(SLOTTED);
    if (selector.indexOf(HOST) >= 0) {
      selector = this._transformHostSelector(selector, hostScope);
    // replace other selectors with scoping class
    } else if (slottedIndex !== 0) {
      selector = scope ? this._transformSimpleSelector(selector, scope) :
        selector;
    }
    // mark ::slotted() scope jump to replace with descendant selector + arg
    // also ignore left-side combinator
    let slotted = false;
    if (slottedIndex >= 0) {
      combinator = '';
      slotted = true;
    }
    // process scope jumping selectors up to the scope jump and then stop
    let stop;
    if (slotted) {
      stop = true;
      if (slotted) {
        // .zonk ::slotted(.foo) -> .zonk.scope > .foo
        selector = selector.replace(SLOTTED_PAREN, (m, paren) => ` > ${paren}`);
      }
    }
    selector = selector.replace(DIR_PAREN, (m, before, dir) =>
      `[dir="${dir}"] ${before}, ${before}[dir="${dir}"]`);
    return {value: selector, combinator, stop};
  }

  _transformSimpleSelector(selector, scope) {
    let p$ = selector.split(PSEUDO_PREFIX);
    p$[0] += scope;
    return p$.join(PSEUDO_PREFIX);
  }

  // :host(...) -> scopeName...
  _transformHostSelector(selector, hostScope) {
    let m = selector.match(HOST_PAREN);
    let paren = m && m[2].trim() || '';
    if (paren) {
      if (!paren[0].match(SIMPLE_SELECTOR_PREFIX)) {
        // paren starts with a type selector
        let typeSelector = paren.split(SIMPLE_SELECTOR_PREFIX)[0];
        // if the type selector is our hostScope then avoid pre-pending it
        if (typeSelector === hostScope) {
          return paren;
        // otherwise, this selector should not match in this scope so
        // output a bogus selector.
        } else {
          return SELECTOR_NO_MATCH;
        }
      } else {
        // make sure to do a replace here to catch selectors like:
        // `:host(.foo)::before`
        return selector.replace(HOST_PAREN, function(m, host, paren) {
          return hostScope + paren;
        });
      }
    // if no paren, do a straight :host replacement.
    // TODO(sorvell): this should not strictly be necessary but
    // it's needed to maintain support for `:host[foo]` type selectors
    // which have been improperly used under Shady DOM. This should be
    // deprecated.
    } else {
      return selector.replace(HOST, hostScope);
    }
  }

  /**
   * @param {StyleNode} rule
   */
  documentRule(rule) {
    // reset selector in case this is redone.
    rule['selector'] = rule['parsedSelector'];
    this.normalizeRootSelector(rule);
    this._transformRule(rule, this._transformDocumentSelector);
  }

  /**
   * @param {StyleNode} rule
   */
  normalizeRootSelector(rule) {
    if (rule['selector'] === ROOT) {
      rule['selector'] = 'html';
    }
  }

/**
 * @param {string} selector
 */
  _transformDocumentSelector(selector) {
    return selector.match(SLOTTED) ?
      this._transformComplexSelector(selector, SCOPE_DOC_SELECTOR) :
      this._transformSimpleSelector(selector.trim(), SCOPE_DOC_SELECTOR);
  }
}

let NTH = /:(nth[-\w]+)\(([^)]+)\)/;
let SCOPE_DOC_SELECTOR = `:not(.${SCOPE_NAME})`;
let COMPLEX_SELECTOR_SEP = ',';
let SIMPLE_SELECTOR_SEP = /(^|[\s>+~]+)((?:\[.+?\]|[^\s>+~=[])+)/g;
let SIMPLE_SELECTOR_PREFIX = /[[.:#*]/;
let HOST = ':host';
let ROOT = ':root';
let SLOTTED = '::slotted';
let SLOTTED_START = new RegExp(`^(${SLOTTED})`);
// NOTE: this supports 1 nested () pair for things like
// :host(:not([selected]), more general support requires
// parsing which seems like overkill
let HOST_PAREN = /(:host)(?:\(((?:\([^)(]*\)|[^)(]*)+?)\))/;
// similar to HOST_PAREN
let SLOTTED_PAREN = /(?:::slotted)(?:\(((?:\([^)(]*\)|[^)(]*)+?)\))/;
let DIR_PAREN = /(.*):dir\((?:(ltr|rtl))\)/;
let CSS_CLASS_PREFIX = '.';
let PSEUDO_PREFIX = ':';
let CLASS = 'class';
let SELECTOR_NO_MATCH = 'should_not_match';

var StyleTransformer$1 = new StyleTransformer();

/**
@license
Copyright (c) 2017 The Polymer Project Authors. All rights reserved.
This code may only be used under the BSD style license found at http://polymer.github.io/LICENSE.txt
The complete set of authors may be found at http://polymer.github.io/AUTHORS.txt
The complete set of contributors may be found at http://polymer.github.io/CONTRIBUTORS.txt
Code distributed by Google as part of the polymer project is also
subject to an additional IP rights grant found at http://polymer.github.io/PATENTS.txt
*/

/** @const {string} */
const infoKey = '__styleInfo';

class StyleInfo {
  /**
   * @param {Element} node
   * @return {StyleInfo}
   */
  static get(node) {
    if (node) {
      return node[infoKey];
    } else {
      return null;
    }
  }
  /**
   * @param {!Element} node
   * @param {StyleInfo} styleInfo
   * @return {StyleInfo}
   */
  static set(node, styleInfo) {
    node[infoKey] = styleInfo;
    return styleInfo;
  }
  /**
   * @param {StyleNode} ast
   * @param {Node=} placeholder
   * @param {Array<string>=} ownStylePropertyNames
   * @param {string=} elementName
   * @param {string=} typeExtension
   * @param {string=} cssBuild
   */
  constructor(ast, placeholder, ownStylePropertyNames, elementName, typeExtension, cssBuild) {
    /** @type {StyleNode} */
    this.styleRules = ast || null;
    /** @type {Node} */
    this.placeholder = placeholder || null;
    /** @type {!Array<string>} */
    this.ownStylePropertyNames = ownStylePropertyNames || [];
    /** @type {Array<Object>} */
    this.overrideStyleProperties = null;
    /** @type {string} */
    this.elementName = elementName || '';
    /** @type {string} */
    this.cssBuild = cssBuild || '';
    /** @type {string} */
    this.typeExtension = typeExtension || '';
    /** @type {Object<string, string>} */
    this.styleProperties = null;
    /** @type {?string} */
    this.scopeSelector = null;
    /** @type {HTMLStyleElement} */
    this.customStyle = null;
  }
  _getStyleRules() {
    return this.styleRules;
  }
}

StyleInfo.prototype['_getStyleRules'] = StyleInfo.prototype._getStyleRules;

/**
@license
Copyright (c) 2017 The Polymer Project Authors. All rights reserved.
This code may only be used under the BSD style license found at http://polymer.github.io/LICENSE.txt
The complete set of authors may be found at http://polymer.github.io/AUTHORS.txt
The complete set of contributors may be found at http://polymer.github.io/CONTRIBUTORS.txt
Code distributed by Google as part of the polymer project is also
subject to an additional IP rights grant found at http://polymer.github.io/PATENTS.txt
*/

// TODO: dedupe with shady
/**
 * @const {function(string):boolean}
 */
const matchesSelector$1 = ((p) => p.matches || p.matchesSelector ||
  p.mozMatchesSelector || p.msMatchesSelector ||
p.oMatchesSelector || p.webkitMatchesSelector)(window.Element.prototype);

const IS_IE = navigator.userAgent.match('Trident');

const XSCOPE_NAME = 'x-scope';

class StyleProperties {
  get XSCOPE_NAME() {
    return XSCOPE_NAME;
  }
/**
 * decorates styles with rule info and returns an array of used style property names
 *
 * @param {StyleNode} rules
 * @return {Array<string>}
 */
  decorateStyles(rules) {
    let self = this, props = {}, keyframes = [], ruleIndex = 0;
    forEachRule(rules, function(rule) {
      self.decorateRule(rule);
      // mark in-order position of ast rule in styles block, used for cache key
      rule.index = ruleIndex++;
      self.collectPropertiesInCssText(rule.propertyInfo.cssText, props);
    }, function onKeyframesRule(rule) {
      keyframes.push(rule);
    });
    // Cache all found keyframes rules for later reference:
    rules._keyframes = keyframes;
    // return this list of property names *consumes* in these styles.
    let names = [];
    for (let i in props) {
      names.push(i);
    }
    return names;
  }

  // decorate a single rule with property info
  decorateRule(rule) {
    if (rule.propertyInfo) {
      return rule.propertyInfo;
    }
    let info = {}, properties = {};
    let hasProperties = this.collectProperties(rule, properties);
    if (hasProperties) {
      info.properties = properties;
      // TODO(sorvell): workaround parser seeing mixins as additional rules
      rule['rules'] = null;
    }
    info.cssText = this.collectCssText(rule);
    rule.propertyInfo = info;
    return info;
  }

  // collects the custom properties from a rule's cssText
  collectProperties(rule, properties) {
    let info = rule.propertyInfo;
    if (info) {
      if (info.properties) {
        Object.assign(properties, info.properties);
        return true;
      }
    } else {
      let m, rx = VAR_ASSIGN;
      let cssText = rule['parsedCssText'];
      let value;
      let any;
      while ((m = rx.exec(cssText))) {
        // note: group 2 is var, 3 is mixin
        value = (m[2] || m[3]).trim();
        // value of 'inherit' or 'unset' is equivalent to not setting the property here
        if (value !== 'inherit' || value !== 'unset') {
          properties[m[1].trim()] = value;
        }
        any = true;
      }
      return any;
    }

  }

  // returns cssText of properties that consume variables/mixins
  collectCssText(rule) {
    return this.collectConsumingCssText(rule['parsedCssText']);
  }

  // NOTE: we support consumption inside mixin assignment
  // but not production, so strip out {...}
  collectConsumingCssText(cssText) {
    return cssText.replace(BRACKETED, '')
      .replace(VAR_ASSIGN, '');
  }

  collectPropertiesInCssText(cssText, props) {
    let m;
    while ((m = VAR_CONSUMED.exec(cssText))) {
      let name = m[1];
      // This regex catches all variable names, and following non-whitespace char
      // If next char is not ':', then variable is a consumer
      if (m[2] !== ':') {
        props[name] = true;
      }
    }
  }

  // turns custom properties into realized values.
  reify(props) {
    // big perf optimization here: reify only *own* properties
    // since this object has __proto__ of the element's scope properties
    let names = Object.getOwnPropertyNames(props);
    for (let i=0, n; i < names.length; i++) {
      n = names[i];
      props[n] = this.valueForProperty(props[n], props);
    }
  }

  // given a property value, returns the reified value
  // a property value may be:
  // (1) a literal value like: red or 5px;
  // (2) a variable value like: var(--a), var(--a, red), or var(--a, --b) or
  // var(--a, var(--b));
  // (3) a literal mixin value like { properties }. Each of these properties
  // can have values that are: (a) literal, (b) variables, (c) @apply mixins.
  valueForProperty(property, props) {
    // case (1) default
    // case (3) defines a mixin and we have to reify the internals
    if (property) {
      if (property.indexOf(';') >=0) {
        property = this.valueForProperties(property, props);
      } else {
        // case (2) variable
        let self = this;
        let fn = function(prefix, value, fallback, suffix) {
          if (!value) {
            return prefix + suffix;
          }
          let propertyValue = self.valueForProperty(props[value], props);
          // if value is "initial", then the variable should be treated as unset
          if (!propertyValue || propertyValue === 'initial') {
            // fallback may be --a or var(--a) or literal
            propertyValue = self.valueForProperty(props[fallback] || fallback, props) ||
            fallback;
          } else if (propertyValue === 'apply-shim-inherit') {
            // CSS build will replace `inherit` with `apply-shim-inherit`
            // for use with native css variables.
            // Since we have full control, we can use `inherit` directly.
            propertyValue = 'inherit';
          }
          return prefix + (propertyValue || '') + suffix;
        };
        property = processVariableAndFallback(property, fn);
      }
    }
    return property && property.trim() || '';
  }

  // note: we do not yet support mixin within mixin
  valueForProperties(property, props) {
    let parts = property.split(';');
    for (let i=0, p, m; i<parts.length; i++) {
      if ((p = parts[i])) {
        MIXIN_MATCH.lastIndex = 0;
        m = MIXIN_MATCH.exec(p);
        if (m) {
          p = this.valueForProperty(props[m[1]], props);
        } else {
          let colon = p.indexOf(':');
          if (colon !== -1) {
            let pp = p.substring(colon);
            pp = pp.trim();
            pp = this.valueForProperty(pp, props) || pp;
            p = p.substring(0, colon) + pp;
          }
        }
        parts[i] = (p && p.lastIndexOf(';') === p.length - 1) ?
          // strip trailing ;
          p.slice(0, -1) :
          p || '';
      }
    }
    return parts.join(';');
  }

  applyProperties(rule, props) {
    let output = '';
    // dynamically added sheets may not be decorated so ensure they are.
    if (!rule.propertyInfo) {
      this.decorateRule(rule);
    }
    if (rule.propertyInfo.cssText) {
      output = this.valueForProperties(rule.propertyInfo.cssText, props);
    }
    rule['cssText'] = output;
  }

  // Apply keyframe transformations to the cssText of a given rule. The
  // keyframeTransforms object is a map of keyframe names to transformer
  // functions which take in cssText and spit out transformed cssText.
  applyKeyframeTransforms(rule, keyframeTransforms) {
    let input = rule['cssText'];
    let output = rule['cssText'];
    if (rule.hasAnimations == null) {
      // Cache whether or not the rule has any animations to begin with:
      rule.hasAnimations = ANIMATION_MATCH.test(input);
    }
    // If there are no animations referenced, we can skip transforms:
    if (rule.hasAnimations) {
      let transform;
      // If we haven't transformed this rule before, we iterate over all
      // transforms:
      if (rule.keyframeNamesToTransform == null) {
        rule.keyframeNamesToTransform = [];
        for (let keyframe in keyframeTransforms) {
          transform = keyframeTransforms[keyframe];
          output = transform(input);
          // If the transform actually changed the CSS text, we cache the
          // transform name for future use:
          if (input !== output) {
            input = output;
            rule.keyframeNamesToTransform.push(keyframe);
          }
        }
      } else {
        // If we already have a list of keyframe names that apply to this
        // rule, we apply only those keyframe name transforms:
        for (let i = 0; i < rule.keyframeNamesToTransform.length; ++i) {
          transform = keyframeTransforms[rule.keyframeNamesToTransform[i]];
          input = transform(input);
        }
        output = input;
      }
    }
    rule['cssText'] = output;
  }

  // Test if the rules in these styles matches the given `element` and if so,
  // collect any custom properties into `props`.
  /**
   * @param {StyleNode} rules
   * @param {Element} element
   */
  propertyDataFromStyles(rules, element) {
    let props = {}, self = this;
    // generates a unique key for these matches
    let o = [];
    // note: active rules excludes non-matching @media rules
    forEachRule(rules, function(rule) {
      // TODO(sorvell): we could trim the set of rules at declaration
      // time to only include ones that have properties
      if (!rule.propertyInfo) {
        self.decorateRule(rule);
      }
      // match element against transformedSelector: selector may contain
      // unwanted uniquification and parsedSelector does not directly match
      // for :host selectors.
      let selectorToMatch = rule.transformedSelector || rule['parsedSelector'];
      if (element && rule.propertyInfo.properties && selectorToMatch) {
        if (matchesSelector$1.call(element, selectorToMatch)) {
          self.collectProperties(rule, props);
          // produce numeric key for these matches for lookup
          addToBitMask(rule.index, o);
        }
      }
    }, null, true);
    return {properties: props, key: o};
  }

  /**
   * @param {Element} scope
   * @param {StyleNode} rule
   * @param {string|undefined} cssBuild
   * @param {function(Object)} callback
   */
  whenHostOrRootRule(scope, rule, cssBuild, callback) {
    if (!rule.propertyInfo) {
      this.decorateRule(rule);
    }
    if (!rule.propertyInfo.properties) {
      return;
    }
    let {is, typeExtension} = getIsExtends(scope);
    let hostScope = is ?
      StyleTransformer$1._calcHostScope(is, typeExtension) :
      'html';
    let parsedSelector = rule['parsedSelector'];
    let isRoot = (parsedSelector === ':host > *' || parsedSelector === 'html');
    let isHost = parsedSelector.indexOf(':host') === 0 && !isRoot;
    // build info is either in scope (when scope is an element) or in the style
    // when scope is the default scope; note: this allows default scope to have
    // mixed mode built and unbuilt styles.
    if (cssBuild === 'shady') {
      // :root -> x-foo > *.x-foo for elements and html for custom-style
      isRoot = parsedSelector === (hostScope + ' > *.' + hostScope) || parsedSelector.indexOf('html') !== -1;
      // :host -> x-foo for elements, but sub-rules have .x-foo in them
      isHost = !isRoot && parsedSelector.indexOf(hostScope) === 0;
    }
    if (cssBuild === 'shadow') {
      isRoot = parsedSelector === ':host > *' || parsedSelector === 'html';
      isHost = isHost && !isRoot;
    }
    if (!isRoot && !isHost) {
      return;
    }
    let selectorToMatch = hostScope;
    if (isHost) {
      // need to transform :host under ShadowDOM because `:host` does not work with `matches`
      if (nativeShadow && !rule.transformedSelector) {
        // transform :host into a matchable selector
        rule.transformedSelector =
        StyleTransformer$1._transformRuleCss(
          rule,
          StyleTransformer$1._transformComplexSelector,
          StyleTransformer$1._calcElementScope(is),
          hostScope
        );
      }
      selectorToMatch = rule.transformedSelector || hostScope;
    }
    callback({
      selector: selectorToMatch,
      isHost: isHost,
      isRoot: isRoot
    });
  }
/**
 * @param {Element} scope
 * @param {StyleNode} rules
 * @return {Object}
 */
  hostAndRootPropertiesForScope(scope, rules) {
    let hostProps = {}, rootProps = {}, self = this;
    // note: active rules excludes non-matching @media rules
    let cssBuild = rules && rules['__cssBuild'];
    forEachRule(rules, function(rule) {
      // if scope is StyleDefaults, use _element for matchesSelector
      self.whenHostOrRootRule(scope, rule, cssBuild, function(info) {
        let element = scope._element || scope;
        if (matchesSelector$1.call(element, info.selector)) {
          if (info.isHost) {
            self.collectProperties(rule, hostProps);
          } else {
            self.collectProperties(rule, rootProps);
          }
        }
      });
    }, null, true);
    return {rootProps: rootProps, hostProps: hostProps};
  }

  /**
   * @param {Element} element
   * @param {Object} properties
   * @param {string} scopeSelector
   */
  transformStyles(element, properties, scopeSelector) {
    let self = this;
    let {is, typeExtension} = getIsExtends(element);
    let hostSelector = StyleTransformer$1
      ._calcHostScope(is, typeExtension);
    let rxHostSelector = element.extends ?
      '\\' + hostSelector.slice(0, -1) + '\\]' :
      hostSelector;
    let hostRx = new RegExp(HOST_PREFIX + rxHostSelector +
      HOST_SUFFIX);
    let rules = StyleInfo.get(element).styleRules;
    let keyframeTransforms =
      this._elementKeyframeTransforms(element, rules, scopeSelector);
    return StyleTransformer$1.elementStyles(element, rules, function(rule) {
      self.applyProperties(rule, properties);
      if (!nativeShadow &&
          !isKeyframesSelector(rule) &&
          rule['cssText']) {
        // NOTE: keyframe transforms only scope munge animation names, so it
        // is not necessary to apply them in ShadowDOM.
        self.applyKeyframeTransforms(rule, keyframeTransforms);
        self._scopeSelector(rule, hostRx, hostSelector, scopeSelector);
      }
    });
  }

  /**
   * @param {Element} element
   * @param {StyleNode} rules
   * @param {string} scopeSelector
   * @return {Object}
   */
  _elementKeyframeTransforms(element, rules, scopeSelector) {
    let keyframesRules = rules._keyframes;
    let keyframeTransforms = {};
    if (!nativeShadow && keyframesRules) {
      // For non-ShadowDOM, we transform all known keyframes rules in
      // advance for the current scope. This allows us to catch keyframes
      // rules that appear anywhere in the stylesheet:
      for (let i = 0, keyframesRule = keyframesRules[i];
           i < keyframesRules.length;
           keyframesRule = keyframesRules[++i]) {
        this._scopeKeyframes(keyframesRule, scopeSelector);
        keyframeTransforms[keyframesRule['keyframesName']] =
            this._keyframesRuleTransformer(keyframesRule);
      }
    }
    return keyframeTransforms;
  }

  // Generate a factory for transforming a chunk of CSS text to handle a
  // particular scoped keyframes rule.
  /**
   * @param {StyleNode} keyframesRule
   * @return {function(string):string}
   */
  _keyframesRuleTransformer(keyframesRule) {
    return function(cssText) {
      return cssText.replace(
          keyframesRule.keyframesNameRx,
          keyframesRule.transformedKeyframesName);
    };
  }

/**
 * Transforms `@keyframes` names to be unique for the current host.
 * Example: @keyframes foo-anim -> @keyframes foo-anim-x-foo-0
 *
 * @param {StyleNode} rule
 * @param {string} scopeId
 */
  _scopeKeyframes(rule, scopeId) {
    rule.keyframesNameRx = new RegExp(rule['keyframesName'], 'g');
    rule.transformedKeyframesName = rule['keyframesName'] + '-' + scopeId;
    rule.transformedSelector = rule.transformedSelector || rule['selector'];
    rule['selector'] = rule.transformedSelector.replace(
        rule['keyframesName'], rule.transformedKeyframesName);
  }

  // Strategy: x scope shim a selector e.g. to scope `.x-foo-42` (via classes):
  // non-host selector: .a.x-foo -> .x-foo-42 .a.x-foo
  // host selector: x-foo.wide -> .x-foo-42.wide
  // note: we use only the scope class (.x-foo-42) and not the hostSelector
  // (x-foo) to scope :host rules; this helps make property host rules
  // have low specificity. They are overrideable by class selectors but,
  // unfortunately, not by type selectors (e.g. overriding via
  // `.special` is ok, but not by `x-foo`).
  /**
   * @param {StyleNode} rule
   * @param {RegExp} hostRx
   * @param {string} hostSelector
   * @param {string} scopeId
   */
  _scopeSelector(rule, hostRx, hostSelector, scopeId) {
    rule.transformedSelector = rule.transformedSelector || rule['selector'];
    let selector = rule.transformedSelector;
    let scope = '.' + scopeId;
    let parts = selector.split(',');
    for (let i=0, l=parts.length, p; (i<l) && (p=parts[i]); i++) {
      parts[i] = p.match(hostRx) ?
        p.replace(hostSelector, scope) :
        scope + ' ' + p;
    }
    rule['selector'] = parts.join(',');
  }

  /**
   * @param {Element} element
   * @param {string} selector
   * @param {string} old
   */
  applyElementScopeSelector(element, selector, old) {
    let c = element.getAttribute('class') || '';
    let v = c;
    if (old) {
      v = c.replace(
        new RegExp('\\s*' + XSCOPE_NAME + '\\s*' + old + '\\s*', 'g'), ' ');
    }
    v += (v ? ' ' : '') + XSCOPE_NAME + ' ' + selector;
    if (c !== v) {
      setElementClassRaw(element, v);
    }
  }

  /**
   * @param {HTMLElement} element
   * @param {Object} properties
   * @param {string} selector
   * @param {HTMLStyleElement} style
   * @return {HTMLStyleElement}
   */
  applyElementStyle(element, properties, selector, style) {
    // calculate cssText to apply
    let cssText = style ? style.textContent || '' :
      this.transformStyles(element, properties, selector);
    // if shady and we have a cached style that is not style, decrement
    let styleInfo = StyleInfo.get(element);
    let s = styleInfo.customStyle;
    if (s && !nativeShadow && (s !== style)) {
      s['_useCount']--;
      if (s['_useCount'] <= 0 && s.parentNode) {
        s.parentNode.removeChild(s);
      }
    }
    // apply styling always under native or if we generated style
    // or the cached style is not in document(!)
    if (nativeShadow) {
      // update existing style only under native
      if (styleInfo.customStyle) {
        styleInfo.customStyle.textContent = cssText;
        style = styleInfo.customStyle;
      // otherwise, if we have css to apply, do so
      } else if (cssText) {
        // apply css after the scope style of the element to help with
        // style precedence rules.
        style = applyCss(cssText, selector, element.shadowRoot,
          styleInfo.placeholder);
      }
    } else {
      // shady and no cache hit
      if (!style) {
        // apply css after the scope style of the element to help with
        // style precedence rules.
        if (cssText) {
          style = applyCss(cssText, selector, null,
            styleInfo.placeholder);
        }
      // shady and cache hit but not in document
      } else if (!style.parentNode) {
        if (IS_IE && cssText.indexOf('@media') > -1) {
            // @media rules may be stale in IE 10 and 11
            // refresh the text content of the style to revalidate them.
          style.textContent = cssText;
        }
        applyStyle(style, null, styleInfo.placeholder);
      }
    }
    // ensure this style is our custom style and increment its use count.
    if (style) {
      style['_useCount'] = style['_useCount'] || 0;
      // increment use count if we changed styles
      if (styleInfo.customStyle != style) {
        style['_useCount']++;
      }
      styleInfo.customStyle = style;
    }
    return style;
  }

  /**
   * @param {Element} style
   * @param {Object} properties
   */
  applyCustomStyle(style, properties) {
    let rules = rulesForStyle(/** @type {HTMLStyleElement} */(style));
    let self = this;
    style.textContent = toCssText(rules, function(/** StyleNode */rule) {
      let css = rule['cssText'] = rule['parsedCssText'];
      if (rule.propertyInfo && rule.propertyInfo.cssText) {
        // remove property assignments
        // so next function isn't confused
        // NOTE: we have 3 categories of css:
        // (1) normal properties,
        // (2) custom property assignments (--foo: red;),
        // (3) custom property usage: border: var(--foo); @apply(--foo);
        // In elements, 1 and 3 are separated for efficiency; here they
        // are not and this makes this case unique.
        css = removeCustomPropAssignment(/** @type {string} */(css));
        // replace with reified properties, scenario is same as mixin
        rule['cssText'] = self.valueForProperties(css, properties);
      }
    });
  }
}

/**
 * @param {number} n
 * @param {Array<number>} bits
 */
function addToBitMask(n, bits) {
  let o = parseInt(n / 32, 10);
  let v = 1 << (n % 32);
  bits[o] = (bits[o] || 0) | v;
}

var StyleProperties$1 = new StyleProperties();

/**
@license
Copyright (c) 2017 The Polymer Project Authors. All rights reserved.
This code may only be used under the BSD style license found at http://polymer.github.io/LICENSE.txt
The complete set of authors may be found at http://polymer.github.io/AUTHORS.txt
The complete set of contributors may be found at http://polymer.github.io/CONTRIBUTORS.txt
Code distributed by Google as part of the polymer project is also
subject to an additional IP rights grant found at http://polymer.github.io/PATENTS.txt
*/

/** @type {Object<string, !Node>} */
let placeholderMap = {};

/**
 * @const {CustomElementRegistry}
 */
const ce = window['customElements'];
if (ce && !nativeShadow) {
  /**
   * @const {function(this:CustomElementRegistry, string,function(new:HTMLElement),{extends: string}=)}
   */
  const origDefine = ce['define'];
  /**
   * @param {string} name
   * @param {function(new:HTMLElement)} clazz
   * @param {{extends: string}=} options
   * @return {function(new:HTMLElement)}
   */
  const wrappedDefine = (name, clazz, options) => {
    placeholderMap[name] = applyStylePlaceHolder(name);
    return origDefine.call(/** @type {!CustomElementRegistry} */(ce), name, clazz, options);
  };
  ce['define'] = wrappedDefine;
}

/**
@license
Copyright (c) 2017 The Polymer Project Authors. All rights reserved.
This code may only be used under the BSD style license found at http://polymer.github.io/LICENSE.txt
The complete set of authors may be found at http://polymer.github.io/AUTHORS.txt
The complete set of contributors may be found at http://polymer.github.io/CONTRIBUTORS.txt
Code distributed by Google as part of the polymer project is also
subject to an additional IP rights grant found at http://polymer.github.io/PATENTS.txt
*/
class StyleCache {
  constructor(typeMax = 100) {
    // map element name -> [{properties, styleElement, scopeSelector}]
    this.cache = {};
    this.typeMax = typeMax;
  }

  _validate(cacheEntry, properties, ownPropertyNames) {
    for (let idx = 0; idx < ownPropertyNames.length; idx++) {
      let pn = ownPropertyNames[idx];
      if (cacheEntry.properties[pn] !== properties[pn]) {
        return false;
      }
    }
    return true;
  }

  store(tagname, properties, styleElement, scopeSelector) {
    let list = this.cache[tagname] || [];
    list.push({properties, styleElement, scopeSelector});
    if (list.length > this.typeMax) {
      list.shift();
    }
    this.cache[tagname] = list;
  }

  fetch(tagname, properties, ownPropertyNames) {
    let list = this.cache[tagname];
    if (!list) {
      return;
    }
    // reverse list for most-recent lookups
    for (let idx = list.length - 1; idx >= 0; idx--) {
      let entry = list[idx];
      if (this._validate(entry, properties, ownPropertyNames)) {
        return entry;
      }
    }
  }
}

/**
@license
Copyright (c) 2017 The Polymer Project Authors. All rights reserved.
This code may only be used under the BSD style license found at http://polymer.github.io/LICENSE.txt
The complete set of authors may be found at http://polymer.github.io/AUTHORS.txt
The complete set of contributors may be found at http://polymer.github.io/CONTRIBUTORS.txt
Code distributed by Google as part of the polymer project is also
subject to an additional IP rights grant found at http://polymer.github.io/PATENTS.txt
*/

let flush$1 = function() {};

/**
 * @param {HTMLElement} element
 * @return {!Array<string>}
 */
function getClasses(element) {
  let classes = [];
  if (element.classList) {
    classes = Array.from(element.classList);
  } else if (element instanceof window['SVGElement'] && element.hasAttribute('class')) {
    classes = element.getAttribute('class').split(/\s+/);
  }
  return classes;
}

/**
 * @param {HTMLElement} element
 * @return {string}
 */
function getCurrentScope(element) {
  let classes = getClasses(element);
  let idx = classes.indexOf(StyleTransformer$1.SCOPE_NAME);
  if (idx > -1) {
    return classes[idx + 1];
  }
  return '';
}

/**
 * @param {Array<MutationRecord|null>|null} mxns
 */
function handler(mxns) {
  for (let x=0; x < mxns.length; x++) {
    let mxn = mxns[x];
    if (mxn.target === document.documentElement ||
      mxn.target === document.head) {
      continue;
    }
    for (let i=0; i < mxn.addedNodes.length; i++) {
      let n = mxn.addedNodes[i];
      if (n.nodeType !== Node.ELEMENT_NODE) {
        continue;
      }
      n = /** @type {HTMLElement} */(n); // eslint-disable-line no-self-assign
      let root = n.getRootNode();
      let currentScope = getCurrentScope(n);
      // node was scoped, but now is in document
      if (currentScope && root === n.ownerDocument) {
        StyleTransformer$1.dom(n, currentScope, true);
      } else if (root.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
        let newScope;
        let host = /** @type {ShadowRoot} */(root).host;
        // element may no longer be in a shadowroot
        if (!host) {
          continue;
        }
        newScope = getIsExtends(host).is;
        if (currentScope === newScope) {
          // make sure all the subtree elements are scoped correctly
          let unscoped = window['ShadyDOM']['nativeMethods']['querySelectorAll'].call(
            n, `:not(.${StyleTransformer$1.SCOPE_NAME})`);
          for (let j = 0; j < unscoped.length; j++) {
            StyleTransformer$1.element(unscoped[j], currentScope);
          }
          continue;
        }
        if (currentScope) {
          StyleTransformer$1.dom(n, currentScope, true);
        }
        StyleTransformer$1.dom(n, newScope);
      }
    }
  }
}

if (!nativeShadow) {
  let observer = new MutationObserver(handler);
  let start = (node) => {
    observer.observe(node, {childList: true, subtree: true});
  };
  let nativeCustomElements = (window['customElements'] &&
    !window['customElements']['polyfillWrapFlushCallback']);
  // need to start immediately with native custom elements
  // TODO(dfreedm): with polyfilled HTMLImports and native custom elements
  // excessive mutations may be observed; this can be optimized via cooperation
  // with the HTMLImports polyfill.
  if (nativeCustomElements) {
    start(document);
  } else {
    let delayedStart = () => {
      start(document.body);
    };
    // use polyfill timing if it's available
    if (window['HTMLImports']) {
      window['HTMLImports']['whenReady'](delayedStart);
    // otherwise push beyond native imports being ready
    // which requires RAF + readystate interactive.
    } else {
      requestAnimationFrame(function() {
        if (document.readyState === 'loading') {
          let listener = function() {
            delayedStart();
            document.removeEventListener('readystatechange', listener);
          };
          document.addEventListener('readystatechange', listener);
        } else {
          delayedStart();
        }
      });
    }
  }

  flush$1 = function() {
    handler(observer.takeRecords());
  };
}

/**
@license
Copyright (c) 2017 The Polymer Project Authors. All rights reserved.
This code may only be used under the BSD style license found at http://polymer.github.io/LICENSE.txt
The complete set of authors may be found at http://polymer.github.io/AUTHORS.txt
The complete set of contributors may be found at http://polymer.github.io/CONTRIBUTORS.txt
Code distributed by Google as part of the polymer project is also
subject to an additional IP rights grant found at http://polymer.github.io/PATENTS.txt
*/

/**
 * @const {!Object<string, !HTMLTemplateElement>}
 */
const templateMap = {};

/**
@license
Copyright (c) 2017 The Polymer Project Authors. All rights reserved.
This code may only be used under the BSD style license found at http://polymer.github.io/LICENSE.txt
The complete set of authors may be found at http://polymer.github.io/AUTHORS.txt
The complete set of contributors may be found at http://polymer.github.io/CONTRIBUTORS.txt
Code distributed by Google as part of the polymer project is also
subject to an additional IP rights grant found at http://polymer.github.io/PATENTS.txt
*/

/*
 * Utilities for handling invalidating apply-shim mixins for a given template.
 *
 * The invalidation strategy involves keeping track of the "current" version of a template's mixins, and updating that count when a mixin is invalidated.
 * The template
 */

/** @const {string} */
const CURRENT_VERSION = '_applyShimCurrentVersion';

/** @const {string} */
const NEXT_VERSION = '_applyShimNextVersion';

/** @const {string} */
const VALIDATING_VERSION = '_applyShimValidatingVersion';

/**
 * @const {Promise<void>}
 */
const promise = Promise.resolve();

/**
 * @param {string} elementName
 */
function invalidate(elementName){
  let template = templateMap[elementName];
  if (template) {
    invalidateTemplate(template);
  }
}

/**
 * This function can be called multiple times to mark a template invalid
 * and signal that the style inside must be regenerated.
 *
 * Use `startValidatingTemplate` to begin an asynchronous validation cycle.
 * During that cycle, call `templateIsValidating` to see if the template must
 * be revalidated
 * @param {HTMLTemplateElement} template
 */
function invalidateTemplate(template) {
  // default the current version to 0
  template[CURRENT_VERSION] = template[CURRENT_VERSION] || 0;
  // ensure the "validating for" flag exists
  template[VALIDATING_VERSION] = template[VALIDATING_VERSION] || 0;
  // increment the next version
  template[NEXT_VERSION] = (template[NEXT_VERSION] || 0) + 1;
}

/**
 * @param {string} elementName
 * @return {boolean}
 */


/**
 * @param {HTMLTemplateElement} template
 * @return {boolean}
 */
function templateIsValid(template) {
  return template[CURRENT_VERSION] === template[NEXT_VERSION];
}

/**
 * @param {string} elementName
 * @return {boolean}
 */


/**
 * Returns true if the template is currently invalid and `startValidating` has been called since the last invalidation.
 * If false, the template must be validated.
 * @param {HTMLTemplateElement} template
 * @return {boolean}
 */
function templateIsValidating(template) {
  return !templateIsValid(template) && template[VALIDATING_VERSION] === template[NEXT_VERSION];
}

/**
 * the template is marked as `validating` for one microtask so that all instances
 * found in the tree crawl of `applyStyle` will update themselves,
 * but the template will only be updated once.
 * @param {string} elementName
*/


/**
 * Begin an asynchronous invalidation cycle.
 * This should be called after every validation of a template
 *
 * After one microtask, the template will be marked as valid until the next call to `invalidateTemplate`
 * @param {HTMLTemplateElement} template
 */
function startValidatingTemplate(template) {
  // remember that the current "next version" is the reason for this validation cycle
  template[VALIDATING_VERSION] = template[NEXT_VERSION];
  // however, there only needs to be one async task to clear the counters
  if (!template._validating) {
    template._validating = true;
    promise.then(function() {
      // sync the current version to let future invalidations cause a refresh cycle
      template[CURRENT_VERSION] = template[NEXT_VERSION];
      template._validating = false;
    });
  }
}

/**
 * @return {boolean}
 */

/**
@license
Copyright (c) 2017 The Polymer Project Authors. All rights reserved.
This code may only be used under the BSD style license found at http://polymer.github.io/LICENSE.txt
The complete set of authors may be found at http://polymer.github.io/AUTHORS.txt
The complete set of contributors may be found at http://polymer.github.io/CONTRIBUTORS.txt
Code distributed by Google as part of the polymer project is also
subject to an additional IP rights grant found at http://polymer.github.io/PATENTS.txt
*/

/** @type {Promise<void>} */
let readyPromise = null;

/** @type {?function(?function())} */
let whenReady = window['HTMLImports'] && window['HTMLImports']['whenReady'] || null;

/** @type {function()} */
let resolveFn;

/**
 * @param {?function()} callback
 */
function documentWait(callback) {
  requestAnimationFrame(function() {
    if (whenReady) {
      whenReady(callback);
    } else {
      if (!readyPromise) {
        readyPromise = new Promise((resolve) => {resolveFn = resolve;});
        if (document.readyState === 'complete') {
          resolveFn();
        } else {
          document.addEventListener('readystatechange', () => {
            if (document.readyState === 'complete') {
              resolveFn();
            }
          });
        }
      }
      readyPromise.then(function(){ callback && callback(); });
    }
  });
}

/**
@license
Copyright (c) 2017 The Polymer Project Authors. All rights reserved.
This code may only be used under the BSD style license found at http://polymer.github.io/LICENSE.txt
The complete set of authors may be found at http://polymer.github.io/AUTHORS.txt
The complete set of contributors may be found at http://polymer.github.io/CONTRIBUTORS.txt
Code distributed by Google as part of the polymer project is also
subject to an additional IP rights grant found at http://polymer.github.io/PATENTS.txt
*/

/**
 * @param {Element} element
 * @param {Object=} properties
 */
function updateNativeProperties(element, properties) {
  // remove previous properties
  for (let p in properties) {
    // NOTE: for bc with shim, don't apply null values.
    if (p === null) {
      element.style.removeProperty(p);
    } else {
      element.style.setProperty(p, properties[p]);
    }
  }
}

/**
 * @param {Element} element
 * @param {string} property
 * @return {string}
 */


/**
 * return true if `cssText` contains a mixin definition or consumption
 * @param {string} cssText
 * @return {boolean}
 */
function detectMixin(cssText) {
  const has = MIXIN_MATCH.test(cssText) || VAR_ASSIGN.test(cssText);
  // reset state of the regexes
  MIXIN_MATCH.lastIndex = 0;
  VAR_ASSIGN.lastIndex = 0;
  return has;
}

/**
@license
Copyright (c) 2017 The Polymer Project Authors. All rights reserved.
This code may only be used under the BSD style license found at http://polymer.github.io/LICENSE.txt
The complete set of authors may be found at http://polymer.github.io/AUTHORS.txt
The complete set of contributors may be found at http://polymer.github.io/CONTRIBUTORS.txt
Code distributed by Google as part of the polymer project is also
subject to an additional IP rights grant found at http://polymer.github.io/PATENTS.txt
*/

/**
 * @typedef {HTMLStyleElement | {getStyle: function():HTMLStyleElement}}
 */


const SEEN_MARKER = '__seenByShadyCSS';
const CACHED_STYLE = '__shadyCSSCachedStyle';

/** @type {?function(!HTMLStyleElement)} */
let transformFn = null;

/** @type {?function()} */
let validateFn = null;

/**
This interface is provided to add document-level <style> elements to ShadyCSS for processing.
These styles must be processed by ShadyCSS to simulate ShadowRoot upper-bound encapsulation from outside styles
In addition, these styles may also need to be processed for @apply rules and CSS Custom Properties

To add document-level styles to ShadyCSS, one can call `ShadyCSS.addDocumentStyle(styleElement)` or `ShadyCSS.addDocumentStyle({getStyle: () => styleElement})`

In addition, if the process used to discover document-level styles can be synchronously flushed, one should set `ShadyCSS.documentStyleFlush`.
This function will be called when calculating styles.

An example usage of the document-level styling api can be found in `examples/document-style-lib.js`

@unrestricted
*/
class CustomStyleInterface$1 {
  constructor() {
    /** @type {!Array<!CustomStyleProvider>} */
    this['customStyles'] = [];
    this['enqueued'] = false;
  }
  /**
   * Queue a validation for new custom styles to batch style recalculations
   */
  enqueueDocumentValidation() {
    if (this['enqueued'] || !validateFn) {
      return;
    }
    this['enqueued'] = true;
    documentWait(validateFn);
  }
  /**
   * @param {!HTMLStyleElement} style
   */
  addCustomStyle(style) {
    if (!style[SEEN_MARKER]) {
      style[SEEN_MARKER] = true;
      this['customStyles'].push(style);
      this.enqueueDocumentValidation();
    }
  }
  /**
   * @param {!CustomStyleProvider} customStyle
   * @return {HTMLStyleElement}
   */
  getStyleForCustomStyle(customStyle) {
    if (customStyle[CACHED_STYLE]) {
      return customStyle[CACHED_STYLE];
    }
    let style;
    if (customStyle['getStyle']) {
      style = customStyle['getStyle']();
    } else {
      style = customStyle;
    }
    return style;
  }
  /**
   * @return {!Array<!CustomStyleProvider>}
   */
  processStyles() {
    const cs = this['customStyles'];
    for (let i = 0; i < cs.length; i++) {
      const customStyle = cs[i];
      if (customStyle[CACHED_STYLE]) {
        continue;
      }
      const style = this.getStyleForCustomStyle(customStyle);
      if (style) {
        // HTMLImports polyfill may have cloned the style into the main document,
        // which is referenced with __appliedElement.
        const styleToTransform = /** @type {!HTMLStyleElement} */(style['__appliedElement'] || style);
        if (transformFn) {
          transformFn(styleToTransform);
        }
        customStyle[CACHED_STYLE] = styleToTransform;
      }
    }
    return cs;
  }
}

CustomStyleInterface$1.prototype['addCustomStyle'] = CustomStyleInterface$1.prototype.addCustomStyle;
CustomStyleInterface$1.prototype['getStyleForCustomStyle'] = CustomStyleInterface$1.prototype.getStyleForCustomStyle;
CustomStyleInterface$1.prototype['processStyles'] = CustomStyleInterface$1.prototype.processStyles;

Object.defineProperties(CustomStyleInterface$1.prototype, {
  'transformCallback': {
    /** @return {?function(!HTMLStyleElement)} */
    get() {
      return transformFn;
    },
    /** @param {?function(!HTMLStyleElement)} fn */
    set(fn) {
      transformFn = fn;
    }
  },
  'validateCallback': {
    /** @return {?function()} */
    get() {
      return validateFn;
    },
    /**
     * @param {?function()} fn
     * @this {CustomStyleInterface}
     */
    set(fn) {
      let needsEnqueue = false;
      if (!validateFn) {
        needsEnqueue = true;
      }
      validateFn = fn;
      if (needsEnqueue) {
        this.enqueueDocumentValidation();
      }
    },
  }
});

/** @typedef {{
 * customStyles: !Array<!CustomStyleProvider>,
 * addCustomStyle: function(!CustomStyleProvider),
 * getStyleForCustomStyle: function(!CustomStyleProvider): HTMLStyleElement,
 * findStyles: function(),
 * transformCallback: ?function(!HTMLStyleElement),
 * validateCallback: ?function()
 * }}
 */

/**
@license
Copyright (c) 2017 The Polymer Project Authors. All rights reserved.
This code may only be used under the BSD style license found at http://polymer.github.io/LICENSE.txt
The complete set of authors may be found at http://polymer.github.io/AUTHORS.txt
The complete set of contributors may be found at http://polymer.github.io/CONTRIBUTORS.txt
Code distributed by Google as part of the polymer project is also
subject to an additional IP rights grant found at http://polymer.github.io/PATENTS.txt
*/

/**
 * @const {StyleCache}
 */
const styleCache = new StyleCache();

class ScopingShim {
  constructor() {
    this._scopeCounter = {};
    this._documentOwner = document.documentElement;
    let ast = new StyleNode();
    ast['rules'] = [];
    this._documentOwnerStyleInfo = StyleInfo.set(this._documentOwner, new StyleInfo(ast));
    this._elementsHaveApplied = false;
    this._applyShim = null;
    /** @type {?CustomStyleInterfaceInterface} */
    this._customStyleInterface = null;
    documentWait(() => {
      this._ensure();
    });
  }
  flush() {
    flush$1();
  }
  _generateScopeSelector(name) {
    let id = this._scopeCounter[name] = (this._scopeCounter[name] || 0) + 1;
    return `${name}-${id}`;
  }
  getStyleAst(style) {
    return rulesForStyle(style);
  }
  styleAstToString(ast) {
    return toCssText(ast);
  }
  _gatherStyles(template) {
    return gatherStyleText(template.content);
  }
  _getCssBuild(template) {
    let style = template.content.querySelector('style');
    if (!style) {
      return '';
    }
    return style.getAttribute('css-build') || '';
  }
  /**
   * Prepare the styling and template for the given element type
   *
   * @param {HTMLTemplateElement} template
   * @param {string} elementName
   * @param {string=} typeExtension
   */
  prepareTemplate(template, elementName, typeExtension) {
    if (template._prepared) {
      return;
    }
    template._prepared = true;
    template.name = elementName;
    template.extends = typeExtension;
    templateMap[elementName] = template;
    let cssBuild = this._getCssBuild(template);
    let cssText = this._gatherStyles(template);
    let info = {
      is: elementName,
      extends: typeExtension,
      __cssBuild: cssBuild,
    };
    if (!nativeShadow) {
      StyleTransformer$1.dom(template.content, elementName);
    }
    // check if the styling has mixin definitions or uses
    this._ensure();
    let hasMixins = detectMixin(cssText);
    let ast = parse(cssText);
    // only run the applyshim transforms if there is a mixin involved
    if (hasMixins && nativeCssVariables && this._applyShim) {
      this._applyShim['transformRules'](ast, elementName);
    }
    template['_styleAst'] = ast;
    template._cssBuild = cssBuild;

    let ownPropertyNames = [];
    if (!nativeCssVariables) {
      ownPropertyNames = StyleProperties$1.decorateStyles(template['_styleAst'], info);
    }
    if (!ownPropertyNames.length || nativeCssVariables) {
      let root = nativeShadow ? template.content : null;
      let placeholder = placeholderMap[elementName];
      let style = this._generateStaticStyle(info, template['_styleAst'], root, placeholder);
      template._style = style;
    }
    template._ownPropertyNames = ownPropertyNames;
  }
  _generateStaticStyle(info, rules, shadowroot, placeholder) {
    let cssText = StyleTransformer$1.elementStyles(info, rules);
    if (cssText.length) {
      return applyCss(cssText, info.is, shadowroot, placeholder);
    }
  }
  _prepareHost(host) {
    let {is, typeExtension} = getIsExtends(host);
    let placeholder = placeholderMap[is];
    let template = templateMap[is];
    let ast;
    let ownStylePropertyNames;
    let cssBuild;
    if (template) {
      ast = template['_styleAst'];
      ownStylePropertyNames = template._ownPropertyNames;
      cssBuild = template._cssBuild;
    }
    return StyleInfo.set(host,
      new StyleInfo(
        ast,
        placeholder,
        ownStylePropertyNames,
        is,
        typeExtension,
        cssBuild
      )
    );
  }
  _ensureApplyShim() {
    if (this._applyShim) {
      return;
    } else if (window.ShadyCSS && window.ShadyCSS.ApplyShim) {
      this._applyShim = window.ShadyCSS.ApplyShim;
      this._applyShim['invalidCallback'] = invalidate;
    }
  }
  _ensureCustomStyleInterface() {
    if (this._customStyleInterface) {
      return;
    } else if (window.ShadyCSS && window.ShadyCSS.CustomStyleInterface) {
      this._customStyleInterface = /** @type {!CustomStyleInterfaceInterface} */(window.ShadyCSS.CustomStyleInterface);
      /** @type {function(!HTMLStyleElement)} */
      this._customStyleInterface['transformCallback'] = (style) => {this.transformCustomStyleForDocument(style);};
      this._customStyleInterface['validateCallback'] = () => {
        requestAnimationFrame(() => {
          if (this._customStyleInterface['enqueued'] || this._elementsHaveApplied) {
            this.flushCustomStyles();
          }
        });
      };
    }
  }
  _ensure() {
    this._ensureApplyShim();
    this._ensureCustomStyleInterface();
  }
  /**
   * Flush and apply custom styles to document
   */
  flushCustomStyles() {
    this._ensure();
    if (!this._customStyleInterface) {
      return;
    }
    let customStyles = this._customStyleInterface['processStyles']();
    // early return if custom-styles don't need validation
    if (!this._customStyleInterface['enqueued']) {
      return;
    }
    if (!nativeCssVariables) {
      this._updateProperties(this._documentOwner, this._documentOwnerStyleInfo);
      this._applyCustomStyles(customStyles);
    } else {
      this._revalidateCustomStyleApplyShim(customStyles);
    }
    this._customStyleInterface['enqueued'] = false;
    // if custom elements have upgraded and there are no native css variables, we must recalculate the whole tree
    if (this._elementsHaveApplied && !nativeCssVariables) {
      this.styleDocument();
    }
  }
  /**
   * Apply styles for the given element
   *
   * @param {!HTMLElement} host
   * @param {Object=} overrideProps
   */
  styleElement(host, overrideProps) {
    let {is} = getIsExtends(host);
    let styleInfo = StyleInfo.get(host);
    if (!styleInfo) {
      styleInfo = this._prepareHost(host);
    }
    // Only trip the `elementsHaveApplied` flag if a node other that the root document has `applyStyle` called
    if (!this._isRootOwner(host)) {
      this._elementsHaveApplied = true;
    }
    if (overrideProps) {
      styleInfo.overrideStyleProperties =
        styleInfo.overrideStyleProperties || {};
      Object.assign(styleInfo.overrideStyleProperties, overrideProps);
    }
    if (!nativeCssVariables) {
     this._updateProperties(host, styleInfo);
      if (styleInfo.ownStylePropertyNames && styleInfo.ownStylePropertyNames.length) {
        this._applyStyleProperties(host, styleInfo);
      }
    } else {
      if (styleInfo.overrideStyleProperties) {
        updateNativeProperties(host, styleInfo.overrideStyleProperties);
      }
      let template = templateMap[is];
      // bail early if there is no shadowroot for this element
      if (!template && !this._isRootOwner(host)) {
        return;
      }
      if (template && template._style && !templateIsValid(template)) {
        // update template
        if (!templateIsValidating(template)) {
          this._ensure();
          this._applyShim && this._applyShim['transformRules'](template['_styleAst'], is);
          template._style.textContent = StyleTransformer$1.elementStyles(host, styleInfo.styleRules);
          startValidatingTemplate(template);
        }
        // update instance if native shadowdom
        if (nativeShadow) {
          let root = host.shadowRoot;
          if (root) {
            let style = root.querySelector('style');
            style.textContent = StyleTransformer$1.elementStyles(host, styleInfo.styleRules);
          }
        }
        styleInfo.styleRules = template['_styleAst'];
      }
    }
  }
  _styleOwnerForNode(node) {
    let root = node.getRootNode();
    let host = root.host;
    if (host) {
      if (StyleInfo.get(host)) {
        return host;
      } else {
        return this._styleOwnerForNode(host);
      }
    }
    return this._documentOwner;
  }
  _isRootOwner(node) {
    return (node === this._documentOwner);
  }
  _applyStyleProperties(host, styleInfo) {
    let is = getIsExtends(host).is;
    let cacheEntry = styleCache.fetch(is, styleInfo.styleProperties, styleInfo.ownStylePropertyNames);
    let cachedScopeSelector = cacheEntry && cacheEntry.scopeSelector;
    let cachedStyle = cacheEntry ? cacheEntry.styleElement : null;
    let oldScopeSelector = styleInfo.scopeSelector;
    // only generate new scope if cached style is not found
    styleInfo.scopeSelector = cachedScopeSelector || this._generateScopeSelector(is);
    let style = StyleProperties$1.applyElementStyle(host, styleInfo.styleProperties, styleInfo.scopeSelector, cachedStyle);
    if (!nativeShadow) {
      StyleProperties$1.applyElementScopeSelector(host, styleInfo.scopeSelector, oldScopeSelector);
    }
    if (!cacheEntry) {
      styleCache.store(is, styleInfo.styleProperties, style, styleInfo.scopeSelector);
    }
    return style;
  }
  _updateProperties(host, styleInfo) {
    let owner = this._styleOwnerForNode(host);
    let ownerStyleInfo = StyleInfo.get(owner);
    let ownerProperties = ownerStyleInfo.styleProperties;
    let props = Object.create(ownerProperties || null);
    let hostAndRootProps = StyleProperties$1.hostAndRootPropertiesForScope(host, styleInfo.styleRules);
    let propertyData = StyleProperties$1.propertyDataFromStyles(ownerStyleInfo.styleRules, host);
    let propertiesMatchingHost = propertyData.properties;
    Object.assign(
      props,
      hostAndRootProps.hostProps,
      propertiesMatchingHost,
      hostAndRootProps.rootProps
    );
    this._mixinOverrideStyles(props, styleInfo.overrideStyleProperties);
    StyleProperties$1.reify(props);
    styleInfo.styleProperties = props;
  }
  _mixinOverrideStyles(props, overrides) {
    for (let p in overrides) {
      let v = overrides[p];
      // skip override props if they are not truthy or 0
      // in order to fall back to inherited values
      if (v || v === 0) {
        props[p] = v;
      }
    }
  }
  /**
   * Update styles of the whole document
   *
   * @param {Object=} properties
   */
  styleDocument(properties) {
    this.styleSubtree(this._documentOwner, properties);
  }
  /**
   * Update styles of a subtree
   *
   * @param {!HTMLElement} host
   * @param {Object=} properties
   */
  styleSubtree(host, properties) {
    let root = host.shadowRoot;
    if (root || this._isRootOwner(host)) {
      this.styleElement(host, properties);
    }
    // process the shadowdom children of `host`
    let shadowChildren = root && (root.children || root.childNodes);
    if (shadowChildren) {
      for (let i = 0; i < shadowChildren.length; i++) {
        let c = /** @type {!HTMLElement} */(shadowChildren[i]);
        this.styleSubtree(c);
      }
    } else {
      // process the lightdom children of `host`
      let children = host.children || host.childNodes;
      if (children) {
        for (let i = 0; i < children.length; i++) {
          let c = /** @type {!HTMLElement} */(children[i]);
          this.styleSubtree(c);
        }
      }
    }
  }
  /* Custom Style operations */
  _revalidateCustomStyleApplyShim(customStyles) {
    for (let i = 0; i < customStyles.length; i++) {
      let c = customStyles[i];
      let s = this._customStyleInterface['getStyleForCustomStyle'](c);
      if (s) {
        this._revalidateApplyShim(s);
      }
    }
  }
  _applyCustomStyles(customStyles) {
    for (let i = 0; i < customStyles.length; i++) {
      let c = customStyles[i];
      let s = this._customStyleInterface['getStyleForCustomStyle'](c);
      if (s) {
        StyleProperties$1.applyCustomStyle(s, this._documentOwnerStyleInfo.styleProperties);
      }
    }
  }
  transformCustomStyleForDocument(style) {
    let ast = rulesForStyle(style);
    forEachRule(ast, (rule) => {
      if (nativeShadow) {
        StyleTransformer$1.normalizeRootSelector(rule);
      } else {
        StyleTransformer$1.documentRule(rule);
      }
      if (nativeCssVariables) {
        this._ensure();
        this._applyShim && this._applyShim['transformRule'](rule);
      }
    });
    if (nativeCssVariables) {
      style.textContent = toCssText(ast);
    } else {
      this._documentOwnerStyleInfo.styleRules.rules.push(ast);
    }
  }
  _revalidateApplyShim(style) {
    if (nativeCssVariables && this._applyShim) {
      let ast = rulesForStyle(style);
      this._ensure();
      this._applyShim['transformRules'](ast);
      style.textContent = toCssText(ast);
    }
  }
  getComputedStyleValue(element, property) {
    let value;
    if (!nativeCssVariables) {
      // element is either a style host, or an ancestor of a style host
      let styleInfo = StyleInfo.get(element) || StyleInfo.get(this._styleOwnerForNode(element));
      value = styleInfo.styleProperties[property];
    }
    // fall back to the property value from the computed styling
    value = value || window.getComputedStyle(element).getPropertyValue(property);
    // trim whitespace that can come after the `:` in css
    // example: padding: 2px -> " 2px"
    return value ? value.trim() : '';
  }
  // given an element and a classString, replaces
  // the element's class with the provided classString and adds
  // any necessary ShadyCSS static and property based scoping selectors
  setElementClass(element, classString) {
    let root = element.getRootNode();
    let classes = classString ? classString.split(/\s/) : [];
    let scopeName = root.host && root.host.localName;
    // If no scope, try to discover scope name from existing class.
    // This can occur if, for example, a template stamped element that
    // has been scoped is manipulated when not in a root.
    if (!scopeName) {
      var classAttr = element.getAttribute('class');
      if (classAttr) {
        let k$ = classAttr.split(/\s/);
        for (let i=0; i < k$.length; i++) {
          if (k$[i] === StyleTransformer$1.SCOPE_NAME) {
            scopeName = k$[i+1];
            break;
          }
        }
      }
    }
    if (scopeName) {
      classes.push(StyleTransformer$1.SCOPE_NAME, scopeName);
    }
    if (!nativeCssVariables) {
      let styleInfo = StyleInfo.get(element);
      if (styleInfo && styleInfo.scopeSelector) {
        classes.push(StyleProperties$1.XSCOPE_NAME, styleInfo.scopeSelector);
      }
    }
    setElementClassRaw(element, classes.join(' '));
  }
  _styleInfoForNode(node) {
    return StyleInfo.get(node);
  }
}

/* exports */
ScopingShim.prototype['flush'] = ScopingShim.prototype.flush;
ScopingShim.prototype['prepareTemplate'] = ScopingShim.prototype.prepareTemplate;
ScopingShim.prototype['styleElement'] = ScopingShim.prototype.styleElement;
ScopingShim.prototype['styleDocument'] = ScopingShim.prototype.styleDocument;
ScopingShim.prototype['styleSubtree'] = ScopingShim.prototype.styleSubtree;
ScopingShim.prototype['getComputedStyleValue'] = ScopingShim.prototype.getComputedStyleValue;
ScopingShim.prototype['setElementClass'] = ScopingShim.prototype.setElementClass;
ScopingShim.prototype['_styleInfoForNode'] = ScopingShim.prototype._styleInfoForNode;
ScopingShim.prototype['transformCustomStyleForDocument'] = ScopingShim.prototype.transformCustomStyleForDocument;
ScopingShim.prototype['getStyleAst'] = ScopingShim.prototype.getStyleAst;
ScopingShim.prototype['styleAstToString'] = ScopingShim.prototype.styleAstToString;
ScopingShim.prototype['flushCustomStyles'] = ScopingShim.prototype.flushCustomStyles;
Object.defineProperties(ScopingShim.prototype, {
  'nativeShadow': {
    get() {
      return nativeShadow;
    }
  },
  'nativeCss': {
    get() {
      return nativeCssVariables;
    }
  }
});

/**
@license
Copyright (c) 2017 The Polymer Project Authors. All rights reserved.
This code may only be used under the BSD style license found at http://polymer.github.io/LICENSE.txt
The complete set of authors may be found at http://polymer.github.io/AUTHORS.txt
The complete set of contributors may be found at http://polymer.github.io/CONTRIBUTORS.txt
Code distributed by Google as part of the polymer project is also
subject to an additional IP rights grant found at http://polymer.github.io/PATENTS.txt
*/

/** @const {ScopingShim} */
const scopingShim$1 = new ScopingShim();

let ApplyShim;
let CustomStyleInterface;

if (window['ShadyCSS']) {
  ApplyShim = window['ShadyCSS']['ApplyShim'];
  CustomStyleInterface = window['ShadyCSS']['CustomStyleInterface'];
}

window.ShadyCSS = {
  ScopingShim: scopingShim$1,
  /**
   * @param {!HTMLTemplateElement} template
   * @param {string} elementName
   * @param {string=} elementExtends
   */
  prepareTemplate(template, elementName, elementExtends) {
    scopingShim$1.flushCustomStyles();
    scopingShim$1.prepareTemplate(template, elementName, elementExtends);
  },

  /**
   * @param {!HTMLElement} element
   * @param {Object=} properties
   */
  styleSubtree(element, properties) {
    scopingShim$1.flushCustomStyles();
    scopingShim$1.styleSubtree(element, properties);
  },

  /**
   * @param {!HTMLElement} element
   */
  styleElement(element) {
    scopingShim$1.flushCustomStyles();
    scopingShim$1.styleElement(element);
  },

  /**
   * @param {Object=} properties
   */
  styleDocument(properties) {
    scopingShim$1.flushCustomStyles();
    scopingShim$1.styleDocument(properties);
  },

  /**
   * @param {Element} element
   * @param {string} property
   * @return {string}
   */
  getComputedStyleValue(element, property) {
    return scopingShim$1.getComputedStyleValue(element, property);
  },

  nativeCss: nativeCssVariables,

  nativeShadow: nativeShadow
};

if (ApplyShim) {
  window.ShadyCSS.ApplyShim = ApplyShim;
}

if (CustomStyleInterface) {
  window.ShadyCSS.CustomStyleInterface = CustomStyleInterface;
}

/**
 * @license
 * Copyright (c) 2014 The Polymer Project Authors. All rights reserved.
 * This code may only be used under the BSD style license found at http://polymer.github.io/LICENSE.txt
 * The complete set of authors may be found at http://polymer.github.io/AUTHORS.txt
 * The complete set of contributors may be found at http://polymer.github.io/CONTRIBUTORS.txt
 * Code distributed by Google as part of the polymer project is also
 * subject to an additional IP rights grant found at http://polymer.github.io/PATENTS.txt
 */

let customElements = window['customElements'];
let HTMLImports = window['HTMLImports'];
let Template = window['HTMLTemplateElement'];

// global for (1) existence means `WebComponentsReady` will file,
// (2) WebComponents.ready == true means event has fired.
window.WebComponents = window.WebComponents || {};

if (customElements && customElements['polyfillWrapFlushCallback']) {
  // Here we ensure that the public `HTMLImports.whenReady`
  // always comes *after* custom elements have upgraded.
  let flushCallback;
  let runAndClearCallback = function runAndClearCallback() {
    if (flushCallback) {
      // make sure to run the HTMLTemplateElement polyfill before custom elements upgrade
      if (Template.bootstrap) {
        Template.bootstrap(window.document);
      }
      let cb = flushCallback;
      flushCallback = null;
      cb();
      return true;
    }
  };
  let origWhenReady = HTMLImports['whenReady'];
  customElements['polyfillWrapFlushCallback'](function(cb) {
    flushCallback = cb;
    origWhenReady(runAndClearCallback);
  });

  HTMLImports['whenReady'] = function(cb) {
    origWhenReady(function() {
      // custom element code may add dynamic imports
      // to match processing of native custom elements before
      // domContentLoaded, we wait for these imports to resolve first.
      if (runAndClearCallback()) {
        HTMLImports['whenReady'](cb);
      } else {
        cb();
      }
    });
  };

}

HTMLImports['whenReady'](function() {
  requestAnimationFrame(function() {
    window.WebComponents.ready = true;
    document.dispatchEvent(new CustomEvent('WebComponentsReady', {bubbles: true}));
  });
});

/**
 * @license
 * Copyright (c) 2014 The Polymer Project Authors. All rights reserved.
 * This code may only be used under the BSD style license found at http://polymer.github.io/LICENSE.txt
 * The complete set of authors may be found at http://polymer.github.io/AUTHORS.txt
 * The complete set of contributors may be found at http://polymer.github.io/CONTRIBUTORS.txt
 * Code distributed by Google as part of the polymer project is also
 * subject to an additional IP rights grant found at http://polymer.github.io/PATENTS.txt
 */

// It's desireable to provide a default stylesheet
// that's convenient for styling unresolved elements, but
// it's cumbersome to have to include this manually in every page.
// It would make sense to put inside some HTMLImport but
// the HTMLImports polyfill does not allow loading of stylesheets
// that block rendering. Therefore this injection is tolerated here.
//
// NOTE: position: relative fixes IE's failure to inherit opacity
// when a child is not statically positioned.
let style = document.createElement('style');
style.textContent = ''
    + 'body {'
    + 'transition: opacity ease-in 0.2s;'
    + ' } \n'
    + 'body[unresolved] {'
    + 'opacity: 0; display: block; overflow: hidden; position: relative;'
    + ' } \n'
    ;
let head = document.querySelector('head');
head.insertBefore(style, head.firstChild);

/**
@license
Copyright (c) 2017 The Polymer Project Authors. All rights reserved.
This code may only be used under the BSD style license found at http://polymer.github.io/LICENSE.txt
The complete set of authors may be found at http://polymer.github.io/AUTHORS.txt
The complete set of contributors may be found at http://polymer.github.io/CONTRIBUTORS.txt
Code distributed by Google as part of the polymer project is also
subject to an additional IP rights grant found at http://polymer.github.io/PATENTS.txt
*/
/*
 * Polyfills loaded: HTML Imports, Custom Elements, Shady DOM/Shady CSS
 * Used in: Safari 9, Firefox, Edge
 */

}());
