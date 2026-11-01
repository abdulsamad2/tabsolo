'use strict';

// Patches the page's main world before any page script runs. Each frame of each WebContentsView loads
// this preload (webPreferences.nodeIntegrationInSubFrames = true in main.js), so iframes get the same
// stealth as the top document — bot.sannysoft's HEADCHR_IFRAME check reads window.chrome on iframes.
//
// Sandbox-friendly: only `webFrame` is used, which is available in a sandboxed preload with context
// isolation. If a define throws, the rest still runs.

const { webFrame, ipcRenderer } = require('electron');

// Recorder bridge. When main injects the recorder script via webContents.executeJavaScript, it
// posts { __fleetRecord: true, ... } events to the page's window. postMessage crosses the context-
// isolation boundary into this preload, so we can forward each event to the main process.
try {
  window.addEventListener('message', (event) => {
    if (event?.source !== window) return;
    const data = event?.data;
    if (!data) return;
    if (data.__fleetRecord === true) { try { ipcRenderer.send('record:action', data); } catch (_) {} }
    else if (data.__fleetReplay === true) { try { ipcRenderer.send('replay:progress', data); } catch (_) {} }
  });
} catch (_) {}

// Encrypted-clipboard paste interceptor. Secrets copied in TabSolo land on the system clipboard as
// `TF~<base64>` tokens; this handler sniffs paste events, swaps the token for the real plaintext
// via a sync IPC round-trip to main, and lets Chromium insert the plaintext into the focused field.
// If decryption fails (different launch, no matching key) the token is cleared, so other apps that
// read the clipboard never see TabSolo's secrets.
const CLIP_PREFIX = 'TF~';
try {
  document.addEventListener('paste', (event) => {
    try {
      const raw = event.clipboardData?.getData('text/plain');
      if (!raw || !raw.startsWith(CLIP_PREFIX)) return;
      // Synchronous IPC — paste must be substituted inside the same event handler.
      const plain = ipcRenderer.sendSync('clipboard:decrypt-sync', raw);
      event.preventDefault();
      event.stopPropagation();
      if (typeof plain !== 'string' || plain.length === 0) return;
      // Prefer the standard "paste text into the focused editable" path.
      const el = document.activeElement;
      if (el && typeof el.setRangeText === 'function' && 'selectionStart' in el) {
        const start = el.selectionStart ?? el.value.length;
        const end = el.selectionEnd ?? el.value.length;
        el.setRangeText(plain, start, end, 'end');
        el.dispatchEvent(new Event('input', { bubbles: true }));
      } else if (document.execCommand) {
        document.execCommand('insertText', false, plain);
      }
    } catch (_) {}
  }, true);
} catch (_) {}

// Per-session seed is passed through webPreferences.additionalArguments (set in main.js) and lands in
// process.argv as --fleet-seed=<hex>. Preloads in subframes see the same argv as the main frame.
const seedArg = process.argv.find((a) => typeof a === 'string' && a.startsWith('--fleet-seed='));
const seedRaw = seedArg ? seedArg.slice('--fleet-seed='.length) : '1';
// Format gate so a future refactor that pipes a non-hex source (profile name, env var) into the
// seed can't turn this inline interpolation into webFrame.executeJavaScript string injection.
const seedHex = /^[0-9a-f]{1,16}$/i.test(seedRaw) ? seedRaw : '1';

webFrame.executeJavaScript(`
  (() => {
    const SEED = parseInt('${seedHex}', 16) || 1;
    // ----- Native-looking toString plumbing -----------------------------------------------------
    // Chrome's getters stringify as "function get <name>() { [native code] }". A naive patch leaves
    // our fake getters as "() => false", which fp-collect prints under navigatorPrototype and uses as
    // a tell. Proxying Function.prototype.toString lets our fakes return the native string instead.
    const nativeLabels = new WeakMap();
    const asNative = (fn, label) => { nativeLabels.set(fn, label); return fn; };
    try {
      const originalToString = Function.prototype.toString;
      const toStringProxy = new Proxy(originalToString, {
        apply(target, thisArg, args) {
          if (thisArg && nativeLabels.has(thisArg)) return nativeLabels.get(thisArg);
          return Reflect.apply(target, thisArg, args);
        },
      });
      nativeLabels.set(toStringProxy, 'function toString() { [native code] }');
      Function.prototype.toString = toStringProxy;
    } catch (_) {}

    // ----- navigator.webdriver -----------------------------------------------------------------
    // Stock Chrome exposes the property as a native getter returning false. Pre-patch Electron builds
    // leave it absent on the prototype.
    try {
      const webdriverGetter = asNative(function () { return false; }, 'function get webdriver() { [native code] }');
      Object.defineProperty(Navigator.prototype, 'webdriver', {
        get: webdriverGetter,
        configurable: true,
        enumerable: true,
      });
    } catch (_) {}

    // ----- window.chrome.* ---------------------------------------------------------------------
    // Stock Chrome on a regular page exposes chrome.app, chrome.csi, chrome.loadTimes, chrome.runtime,
    // and chrome.webstore. The methods are callable but mostly inert without an extension context.
    try {
      if (!window.chrome) window.chrome = {};
      const chrome = window.chrome;
      if (!chrome.runtime) chrome.runtime = {};
      const runtime = chrome.runtime;
      if (!runtime.OnInstalledReason) runtime.OnInstalledReason = { INSTALL: 'install', UPDATE: 'update', CHROME_UPDATE: 'chrome_update', SHARED_MODULE_UPDATE: 'shared_module_update' };
      if (!runtime.PlatformOs) runtime.PlatformOs = { MAC: 'mac', WIN: 'win', LINUX: 'linux', ANDROID: 'android', CROS: 'cros', OPENBSD: 'openbsd' };
      if (!runtime.PlatformArch) runtime.PlatformArch = { ARM: 'arm', ARM64: 'arm64', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' };
      if (!runtime.RequestUpdateCheckStatus) runtime.RequestUpdateCheckStatus = { NO_UPDATE: 'no_update', THROTTLED: 'throttled', UPDATE_AVAILABLE: 'update_available' };
      if (typeof runtime.connect !== 'function') runtime.connect = asNative(function connect() {}, 'function connect() { [native code] }');
      if (typeof runtime.sendMessage !== 'function') runtime.sendMessage = asNative(function sendMessage() {}, 'function sendMessage() { [native code] }');
      if (!('id' in runtime)) runtime.id = undefined;

      if (!chrome.app) {
        chrome.app = {
          isInstalled: false,
          InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
          RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
          getDetails: asNative(function getDetails() { return null; }, 'function getDetails() { [native code] }'),
          getIsInstalled: asNative(function getIsInstalled() { return false; }, 'function getIsInstalled() { [native code] }'),
          installState: asNative(function installState(cb) { if (typeof cb === 'function') cb('not_installed'); }, 'function installState() { [native code] }'),
          runningState: asNative(function runningState() { return 'cannot_run'; }, 'function runningState() { [native code] }'),
        };
      }
      if (typeof chrome.loadTimes !== 'function') {
        const start = Date.now() / 1000;
        chrome.loadTimes = asNative(function loadTimes() {
          return {
            requestTime: start, startLoadTime: start, commitLoadTime: start,
            finishDocumentLoadTime: start, finishLoadTime: start, firstPaintTime: start,
            firstPaintAfterLoadTime: 0, navigationType: 'Other',
            wasFetchedViaSpdy: false, wasNpnNegotiated: true, npnNegotiatedProtocol: 'h2',
            wasAlternateProtocolAvailable: false, connectionInfo: 'h2',
          };
        }, 'function loadTimes() { [native code] }');
      }
      if (typeof chrome.csi !== 'function') {
        chrome.csi = asNative(function csi() {
          return { startE: Date.now(), onloadT: Date.now(), pageT: performance.now(), tran: 15 };
        }, 'function csi() { [native code] }');
      }
      if (!chrome.webstore) {
        chrome.webstore = {
          install: asNative(function install() {}, 'function install() { [native code] }'),
          onInstallStageChanged: {},
          onDownloadProgress: {},
        };
      }
    } catch (_) {}

    // ----- iframe.contentWindow.chrome -------------------------------------------------------
    // bot.sannysoft HEADCHR_IFRAME and fp-collect iframeChrome create a blank same-origin iframe and
    // read iframe.contentWindow.chrome synchronously. Even with nodeIntegrationInSubFrames, our
    // preload may not have executed in that frame yet, so patch the contentWindow getter: whenever a
    // page reads it, copy chrome and the webdriver getter into the child's main world. Only runs for
    // same-origin frames (cross-origin access throws and is caught).
    try {
      const descriptor = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow');
      if (descriptor && descriptor.get) {
        const originalGetter = descriptor.get;
        const patchedGetter = asNative(function () {
          const win = originalGetter.call(this);
          try {
            if (win && !win.chrome) win.chrome = window.chrome;
            if (win && win.Navigator && win.Navigator.prototype && !('webdriver' in win.Navigator.prototype)) {
              Object.defineProperty(win.Navigator.prototype, 'webdriver', {
                get: window.Object.getOwnPropertyDescriptor(Navigator.prototype, 'webdriver').get,
                configurable: true, enumerable: true,
              });
            }
          } catch (_) {}
          return win;
        }, 'function get contentWindow() { [native code] }');
        Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
          get: patchedGetter,
          configurable: true,
          enumerable: true,
        });
      }
      // contentDocument similarly: fp-collect sometimes reaches through contentDocument.defaultView.
      const docDescriptor = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentDocument');
      if (docDescriptor && docDescriptor.get) {
        const originalDocGetter = docDescriptor.get;
        const patchedDocGetter = asNative(function () {
          const doc = originalDocGetter.call(this);
          try {
            const win = doc && doc.defaultView;
            if (win && !win.chrome) win.chrome = window.chrome;
          } catch (_) {}
          return doc;
        }, 'function get contentDocument() { [native code] }');
        Object.defineProperty(HTMLIFrameElement.prototype, 'contentDocument', {
          get: patchedDocGetter,
          configurable: true,
          enumerable: true,
        });
      }
    } catch (_) {}

    // ----- Permissions / Notifications alignment ----------------------------------------------
    try {
      const permissions = window.navigator.permissions;
      if (permissions && typeof permissions.query === 'function') {
        const originalQuery = permissions.query.bind(permissions);
        const wrapped = asNative(function query(parameters) {
          if (parameters && parameters.name === 'notifications') {
            const state = typeof Notification !== 'undefined' && Notification.permission === 'denied'
              ? 'denied'
              : 'prompt';
            return Promise.resolve({ state, status: state, onchange: null });
          }
          return originalQuery(parameters);
        }, 'function query() { [native code] }');
        permissions.query = wrapped;
      }
    } catch (_) {}

    // ----- Deterministic RNG seeded from this session -----------------------------------------
    // Park–Miller LCG: tiny, deterministic, enough for low-bit noise. The same partition seed
    // produces the same sequence, so every tab under one profile hashes identically on reload.
    let rngState = SEED >>> 0 || 1;
    const nextRng = () => {
      rngState = (Math.imul(rngState, 16807) + 1) >>> 0;
      return rngState;
    };

    // ----- WebGL vendor / renderer -----------------------------------------------------------
    // UNMASKED_VENDOR_WEBGL / UNMASKED_RENDERER_WEBGL expose the real GPU (e.g. "Apple M5 Pro") via
    // the WEBGL_debug_renderer_info extension. Replace them with a plausible, platform-matching
    // combo picked by seed so each profile looks like a different common Mac but each profile's
    // tabs look consistent.
    const GPU_COMBOS = [
      { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)' },
      { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1 Pro, Unspecified Version)' },
      { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)' },
      { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Pro, Unspecified Version)' },
      { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M3, Unspecified Version)' },
      { vendor: 'Google Inc. (Intel Inc.)', renderer: 'ANGLE (Intel Inc., Intel(R) Iris(TM) Plus Graphics 650, OpenGL 4.1)' },
    ];
    const combo = GPU_COMBOS[SEED % GPU_COMBOS.length];
    try {
      const patchGL = (proto) => {
        if (!proto || !proto.getParameter) return;
        const originalGetParameter = proto.getParameter;
        proto.getParameter = asNative(function (parameter) {
          // UNMASKED_VENDOR_WEBGL = 37445, UNMASKED_RENDERER_WEBGL = 37446
          if (parameter === 37445) return combo.vendor;
          if (parameter === 37446) return combo.renderer;
          return originalGetParameter.call(this, parameter);
        }, 'function getParameter() { [native code] }');
      };
      if (typeof WebGLRenderingContext !== 'undefined') patchGL(WebGLRenderingContext.prototype);
      if (typeof WebGL2RenderingContext !== 'undefined') patchGL(WebGL2RenderingContext.prototype);
    } catch (_) {}

    // ----- Canvas fingerprint noise ----------------------------------------------------------
    // Fingerprinters draw text/shapes and hash either toDataURL() or getImageData(). Two layers of
    // defense: (1) after each fillText/fillRect/strokeText, stamp an invisible 1×1 pixel at a
    // seed-chosen position with a seed-derived color — this changes the real pixel buffer so even
    // tests that read raw pixels or hash pre-encode content see a different canvas per profile.
    // (2) toDataURL/toBlob also route through a scratch canvas with LSB flips as a backstop.
    try {
      // Capture the native fillRect BEFORE wrapping it — otherwise stampSeed's own ctx.fillRect
      // resolves to the wrapper, which calls stampSeed again, which calls fillRect again, …
      // until Chrome throws stack-overflow on every canvas draw.
      const nativeFillRect = CanvasRenderingContext2D.prototype.fillRect;
      const stampSeed = (ctx) => {
        try {
          const canvas = ctx && ctx.canvas;
          if (!canvas || !canvas.width || !canvas.height) return;
          const savedFill = ctx.fillStyle;
          const savedAlpha = ctx.globalAlpha;
          const x = SEED % canvas.width;
          const y = (SEED >>> 8) % canvas.height;
          const r = SEED & 255;
          const g = (SEED >>> 8) & 255;
          const b = (SEED >>> 16) & 255;
          ctx.globalAlpha = 1;
          ctx.fillStyle = 'rgb(' + r + ',' + g + ',' + b + ')';
          nativeFillRect.call(ctx, x, y, 1, 1);
          ctx.fillStyle = savedFill;
          ctx.globalAlpha = savedAlpha;
        } catch (_) {}
      };
      const wrap = (proto, name, label) => {
        if (!proto || typeof proto[name] !== 'function') return;
        const original = proto[name];
        proto[name] = asNative(function () {
          const result = original.apply(this, arguments);
          stampSeed(this);
          return result;
        }, label);
      };
      wrap(CanvasRenderingContext2D.prototype, 'fillText',   'function fillText() { [native code] }');
      wrap(CanvasRenderingContext2D.prototype, 'strokeText', 'function strokeText() { [native code] }');
      wrap(CanvasRenderingContext2D.prototype, 'fillRect',   'function fillRect() { [native code] }');
    } catch (_) {}

    // Backstop LSB-flip path for toDataURL / toBlob.
    const noiseCanvasPixels = (sourceCanvas) => {
      const w = sourceCanvas.width, h = sourceCanvas.height;
      if (w === 0 || h === 0) return sourceCanvas;
      const temp = document.createElement('canvas');
      temp.width = w; temp.height = h;
      const tempCtx = temp.getContext('2d');
      if (!tempCtx) return sourceCanvas;
      tempCtx.drawImage(sourceCanvas, 0, 0);
      let image;
      try { image = tempCtx.getImageData(0, 0, w, h); } catch (_) { return sourceCanvas; }
      const data = image.data;
      const pixelCount = (data.length / 4) | 0;
      // Reset per-call so the sequence is stable across repeated toDataURL calls.
      rngState = SEED >>> 0 || 1;
      const flips = Math.min(pixelCount, 32);
      for (let i = 0; i < flips; i++) {
        const idx = (nextRng() % pixelCount) * 4;
        data[idx]     = data[idx]     ^ 1;
        data[idx + 1] = data[idx + 1] ^ 1;
        data[idx + 2] = data[idx + 2] ^ 1;
      }
      tempCtx.putImageData(image, 0, 0);
      return temp;
    };
    try {
      const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
      HTMLCanvasElement.prototype.toDataURL = asNative(function toDataURL() {
        try { return originalToDataURL.apply(noiseCanvasPixels(this), arguments); }
        catch (_) { return originalToDataURL.apply(this, arguments); }
      }, 'function toDataURL() { [native code] }');

      const originalToBlob = HTMLCanvasElement.prototype.toBlob;
      HTMLCanvasElement.prototype.toBlob = asNative(function toBlob() {
        try { return originalToBlob.apply(noiseCanvasPixels(this), arguments); }
        catch (_) { return originalToBlob.apply(this, arguments); }
      }, 'function toBlob() { [native code] }');

      // getImageData is a less common fingerprint vector but Fp-collect reads it. Only noise when a
      // caller asks for the whole canvas (fingerprint signature) — leaves per-pixel readback paths
      // used by real apps (image editors, cropping) untouched.
      const originalGetImageData = CanvasRenderingContext2D.prototype.getImageData;
      CanvasRenderingContext2D.prototype.getImageData = asNative(function getImageData(sx, sy, sw, sh) {
        const result = originalGetImageData.call(this, sx, sy, sw, sh);
        try {
          if (this.canvas && sx === 0 && sy === 0 && sw === this.canvas.width && sh === this.canvas.height) {
            rngState = SEED >>> 0 || 1;
            const pixelCount = (result.data.length / 4) | 0;
            const flips = Math.min(pixelCount, 32);
            for (let i = 0; i < flips; i++) {
              const idx = (nextRng() % pixelCount) * 4;
              result.data[idx]     = result.data[idx]     ^ 1;
              result.data[idx + 1] = result.data[idx + 1] ^ 1;
              result.data[idx + 2] = result.data[idx + 2] ^ 1;
            }
          }
        } catch (_) {}
        return result;
      }, 'function getImageData() { [native code] }');
    } catch (_) {}

    // ----- Font fingerprint noise ------------------------------------------------------------
    // browserleaks/fonts hashes measureText().width and the clientRect widths of inline-block spans
    // across hundreds of font families to enumerate every font on the machine (420 fonts, 281 unique
    // metrics on this Mac). Deterministic seeded subpixel noise on these three APIs changes the hash
    // between profiles while staying below the pixel-rounding threshold the browser uses to lay out
    // the actual page, so no visible layout is affected.
    try {
      // Noise is a tiny deterministic fraction derived from the seed and a stable text key, so the
      // same string in the same canvas font yields the same noise every call (stable within a
      // profile, different between profiles).
      const fractionFor = (key) => {
        let h = SEED >>> 0 || 1;
        for (let i = 0; i < key.length; i++) {
          h ^= key.charCodeAt(i);
          h = Math.imul(h, 0x01000193) >>> 0;
        }
        // Map to [-0.3, 0.3) px — well under one layout pixel so CSS rendering is untouched.
        return ((h % 10000) / 10000 - 0.5) * 0.6;
      };

      const originalMeasureText = CanvasRenderingContext2D.prototype.measureText;
      CanvasRenderingContext2D.prototype.measureText = asNative(function measureText(text) {
        const metrics = originalMeasureText.call(this, text);
        const key = (this.font || '') + '|' + String(text);
        const noise = fractionFor(key);
        return new Proxy(metrics, {
          get(target, prop) {
            const value = Reflect.get(target, prop, target);
            if (typeof value === 'number' && (
              prop === 'width' || prop === 'actualBoundingBoxLeft' || prop === 'actualBoundingBoxRight'
            )) {
              return value + noise;
            }
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      }, 'function measureText() { [native code] }');

      const noiseRect = (rect, key) => {
        if (!rect) return rect;
        const noise = fractionFor(key);
        return new Proxy(rect, {
          get(target, prop) {
            const value = Reflect.get(target, prop, target);
            if (typeof value === 'number' && (prop === 'width' || prop === 'right')) {
              return value + noise;
            }
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      };

      const originalElementRect = Element.prototype.getBoundingClientRect;
      Element.prototype.getBoundingClientRect = asNative(function getBoundingClientRect() {
        const rect = originalElementRect.call(this);
        const key = (this.tagName || '') + '|' + ((this.textContent || '').slice(0, 32));
        return noiseRect(rect, key);
      }, 'function getBoundingClientRect() { [native code] }');

      if (typeof Range !== 'undefined' && Range.prototype.getBoundingClientRect) {
        const originalRangeRect = Range.prototype.getBoundingClientRect;
        Range.prototype.getBoundingClientRect = asNative(function getBoundingClientRect() {
          const rect = originalRangeRect.call(this);
          const key = 'range|' + ((this.toString() || '').slice(0, 32));
          return noiseRect(rect, key);
        }, 'function getBoundingClientRect() { [native code] }');
      }
    } catch (_) {}

    // ----- navigator.userAgentData brands ----------------------------------------------------
    // Chromium builds .brands from the compiled product name, so without patching it, JavaScript
    // reads [{brand:"TabSolo", version:"1.3.10"}, {brand:"Chromium", ...}, {brand:"Not=A?Brand", ...}]
    // even though our Sec-CH-UA header is clean. Rewrite the brands list and getHighEntropyValues.
    try {
      const uaData = navigator.userAgentData;
      if (uaData) {
        const major = (navigator.userAgent.match(/Chrome\\/(\\d+)/) || [])[1] || '140';
        const fullVersion = (navigator.userAgent.match(/Chrome\\/([\\d.]+)/) || [])[1] || '140.0.0.0';
        const cleanBrands = [
          { brand: 'Chromium', version: major },
          { brand: 'Google Chrome', version: major },
          { brand: 'Not=A?Brand', version: '24' },
        ];
        const cleanFullBrands = [
          { brand: 'Chromium', version: fullVersion },
          { brand: 'Google Chrome', version: fullVersion },
          { brand: 'Not=A?Brand', version: '24.0.0.0' },
        ];
        const platform = navigator.platform === 'Win32' ? 'Windows' : navigator.platform.startsWith('Mac') ? 'macOS' : 'Linux';
        Object.defineProperty(uaData, 'brands', {
          get: asNative(function () { return cleanBrands.slice(); }, 'function get brands() { [native code] }'),
          configurable: true, enumerable: true,
        });
        Object.defineProperty(uaData, 'mobile', {
          get: asNative(function () { return false; }, 'function get mobile() { [native code] }'),
          configurable: true, enumerable: true,
        });
        Object.defineProperty(uaData, 'platform', {
          get: asNative(function () { return platform; }, 'function get platform() { [native code] }'),
          configurable: true, enumerable: true,
        });
        if (typeof uaData.getHighEntropyValues === 'function') {
          uaData.getHighEntropyValues = asNative(function getHighEntropyValues(hints) {
            const result = {
              brands: cleanBrands.slice(),
              mobile: false,
              platform,
              architecture: 'x86',
              bitness: '64',
              model: '',
              platformVersion: platform === 'macOS' ? '15.0.0' : platform === 'Windows' ? '15.0.0' : '',
              uaFullVersion: fullVersion,
              fullVersionList: cleanFullBrands.slice(),
              wow64: false,
              formFactors: ['Desktop'],
            };
            const filtered = { brands: result.brands, mobile: result.mobile, platform: result.platform };
            if (Array.isArray(hints)) for (const h of hints) if (h in result) filtered[h] = result[h];
            return Promise.resolve(filtered);
          }, 'function getHighEntropyValues() { [native code] }');
        }
      }
    } catch (_) {}

    // ----- Window dimensions ------------------------------------------------------------------
    // TabSolo puts a sidebar beside the tab view, so a page sees window.innerWidth = 1080 and
    // window.outerWidth = 1400. Stock Chrome has outer ≈ inner (the window chrome has no horizontal
    // bars); the 320-pixel gap is a tell. Reclamp outer dimensions to Chrome-like values: horizontal
    // identical to inner, vertical ~86px taller (tab bar + toolbar).
    try {
      Object.defineProperty(window, 'outerWidth', {
        get: asNative(function () { return window.innerWidth; }, 'function get outerWidth() { [native code] }'),
        configurable: true, enumerable: true,
      });
      Object.defineProperty(window, 'outerHeight', {
        get: asNative(function () { return window.innerHeight + 86; }, 'function get outerHeight() { [native code] }'),
        configurable: true, enumerable: true,
      });
    } catch (_) {}

    // ----- AudioContext fingerprint noise ----------------------------------------------------
    // Fingerprinters compare the output of an OscillatorNode → DynamicsCompressorNode → AnalyserNode
    // chain across users. The buffer differs by platform/driver, so a stable per-profile noise on
    // the floats returned by getFloatFrequencyData/getFloatTimeDomainData keeps the audio hash
    // distinct per account.
    try {
      const audioNoise = (SEED % 1000) / 1e7; // ~1e-7 range, inaudible but changes the hash
      const wrapGetFloat = (proto, name) => {
        if (!proto || typeof proto[name] !== 'function') return;
        const original = proto[name];
        proto[name] = asNative(function (array) {
          original.call(this, array);
          if (array && array.length) {
            for (let i = 0; i < array.length; i++) array[i] = array[i] + audioNoise;
          }
        }, 'function ' + name + '() { [native code] }');
      };
      if (typeof AnalyserNode !== 'undefined') {
        wrapGetFloat(AnalyserNode.prototype, 'getFloatFrequencyData');
        wrapGetFloat(AnalyserNode.prototype, 'getFloatTimeDomainData');
      }
      if (typeof AudioBuffer !== 'undefined' && AudioBuffer.prototype.getChannelData) {
        const originalGetChannelData = AudioBuffer.prototype.getChannelData;
        AudioBuffer.prototype.getChannelData = asNative(function getChannelData(channel) {
          const data = originalGetChannelData.call(this, channel);
          // Mutate once per buffer so audio playback isn't degraded on repeated reads.
          if (!this.__fleetNoised) {
            for (let i = 0; i < data.length; i += 100) data[i] = data[i] + audioNoise;
            Object.defineProperty(this, '__fleetNoised', { value: true });
          }
          return data;
        }, 'function getChannelData() { [native code] }');
      }
    } catch (_) {}

    // ----- navigator.languages belt-and-suspenders -------------------------------------------
    // --lang=en-US on the command line should settle this at the Chromium level, but override the
    // JS getters too in case anything else in the stack re-reads the macOS system locale.
    try {
      Object.defineProperty(Navigator.prototype, 'language', {
        get: asNative(function () { return 'en-US'; }, 'function get language() { [native code] }'),
        configurable: true, enumerable: true,
      });
      Object.defineProperty(Navigator.prototype, 'languages', {
        get: asNative(function () { return ['en-US', 'en']; }, 'function get languages() { [native code] }'),
        configurable: true, enumerable: true,
      });
    } catch (_) {}
  })();
`);
