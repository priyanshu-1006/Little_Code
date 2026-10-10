import { redactSecrets } from '../context/redact-secrets';
import { LittleError } from '../shared/errors';
import { assertNotAborted } from '../tools/workspace-service';

export const BROWSER_LIMITS = Object.freeze({ httpBytes: 64 * 1024, messageBytes: 8 * 1024 * 1024, textChars: 8_000, screenshotBytes: 4 * 1024 * 1024, totalMs: 20_000, cleanupMs: 2_000, requestMs: 4_000 });
export interface BrowserSnapshot { url: string; title: string; text: string; screenshot?: string; truncated: boolean }
interface Pending { resolve(value: unknown): void; reject(error: unknown): void; timer: ReturnType<typeof setTimeout> }
interface Inspection {
  controller: AbortController;
  approved: URL;
  targetId?: string;
  socket?: WebSocket;
  pending: Map<number, Pending>;
  nextId: number;
  failure?: LittleError;
  close?: Promise<void>;
  loaded: Promise<void>;
  resolveLoaded(): void;
  rejectLoaded(error: unknown): void;
  navigated: boolean;
  blockedNavigation?: Promise<void>;
}
const TARGET_ID = /^[A-Za-z0-9_-]{1,128}$/;
const FIXED_DOM_EXPRESSION = `(()=>{const limit=8000;const parts=[];let length=0,visited=0,truncated=false;const root=document.body||document.documentElement;if(root){const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);let node;while((node=walker.nextNode())){if(++visited>10000){truncated=true;break;}const parent=node.parentElement;if(!parent||parent.closest('script,style,noscript,template,[hidden],input,textarea,select,form,[contenteditable],[role="textbox"],[aria-hidden="true"]'))continue;const style=getComputedStyle(parent);if(style.display==='none'||style.visibility==='hidden'||!parent.getClientRects().length)continue;const raw=node.textContent||'';if(raw.length>limit+1)truncated=true;const value=raw.slice(0,limit+1).replace(/\\s+/g,' ').trim();if(!value)continue;const available=Math.max(0,limit-length);if(!available){truncated=true;break;}if(value.length>available){parts.push(value.slice(0,available));truncated=true;break;}parts.push(value);length+=value.length+1;}}return{url:location.href,title:document.title.slice(0,200),text:parts.join('\\n').slice(0,limit),truncated};})()`;

function record(value: unknown): Record<string, unknown> | undefined { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function failed(message: string): LittleError { return new LittleError('TOOL_FAILED', message); }
function loopback(url: URL): boolean { return ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname.toLowerCase()); }
function appUrl(value: string): URL {
  explicitLoopback(value, true);
  let url: URL;
  try { url = new URL(value); } catch { throw new LittleError('TOOL_VALIDATION_FAILED', 'Browser inspection needs a valid local application URL.'); }
  if (value.length > 4_096 || url.href.length > 4_096 || !['http:', 'https:'].includes(url.protocol) || !loopback(url) || url.username || url.password || value.includes('#') || redactSecrets(value) !== value) throw new LittleError('PERMISSION_DENIED', 'Browser inspection is limited to explicit loopback HTTP or HTTPS applications without credentials, fragments, or secret-bearing URLs.');
  if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
  return url;
}

function explicitLoopback(value: string, page: boolean): void {
  if (typeof value !== 'string' || /[\s\u0000-\u001f\u007f]/.test(value)) throw new LittleError('TOOL_VALIDATION_FAILED', 'Browser URLs cannot contain whitespace or control characters.');
  const match = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::([0-9]{1,5}))?(?:[/?#]|$)/i.exec(value);
  if (!match || (match[1] !== undefined && (Number(match[1]) < 1 || Number(match[1]) > 65_535))) throw new LittleError('PERMISSION_DENIED', `Use an explicit loopback ${page ? 'application URL' : 'debugging origin'} with a valid port.`);
}

export function validateBrowserPage(value: string): string { return appUrl(value).href; }

export function validateBrowserEndpoint(value: string): string {
  explicitLoopback(value, false);
  if (value.length > 2_048) throw new LittleError('TOOL_VALIDATION_FAILED', 'Configure a bounded Chromium debugging origin.');
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new LittleError('TOOL_VALIDATION_FAILED', 'Configure a valid loopback Chromium debugging origin.'); }
  if (!/^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]{1,5})?\/?$/i.test(value) || parsed.protocol !== 'http:' || !loopback(parsed) || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || value.includes('#') || redactSecrets(value) !== value) throw new LittleError('PERMISSION_DENIED', 'Chromium debugging must use an existing loopback HTTP origin without credentials, paths, or redirects.');
  if (parsed.hostname === 'localhost') parsed.hostname = '127.0.0.1';
  return parsed.origin;
}

/** Inspects only a fresh, owned Chromium target. No user-tab discovery, launch, or interaction API. */
export class BrowserClient {
  private readonly endpoint: URL;
  private readonly active = new Set<Inspection>();
  private disposed = false;

  constructor(endpoint: string, private readonly fetcher: typeof fetch = fetch) {
    this.endpoint = new URL(validateBrowserEndpoint(endpoint));
  }

  private check(run: Inspection): void {
    if (run.failure) throw run.failure;
    assertNotAborted(run.controller.signal);
  }

  private fail(run: Inspection, error: LittleError): void {
    run.failure ??= error;
    run.controller.abort(error);
  }

  private async http(route: string, method: 'GET' | 'PUT', signal: AbortSignal): Promise<string> {
    const url = new URL(route, this.endpoint);
    const response = await this.fetcher(url, { method, signal, redirect: 'error', credentials: 'omit', cache: 'no-store', headers: { Accept: 'application/json' } });
    if (response.redirected || (response.url && new URL(response.url).href !== url.href) || !response.ok) throw failed('The local Chromium debugging endpoint rejected a protected request.');
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > BROWSER_LIMITS.httpBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new LittleError('CONTEXT_LIMIT', 'The browser debugging response exceeds its size limit.');
    }
    const reader = response.body?.getReader();
    if (!reader) return '';
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        assertNotAborted(signal);
        const result = await reader.read();
        if (result.done) break;
        bytes += result.value.byteLength;
        if (bytes > BROWSER_LIMITS.httpBytes) throw new LittleError('CONTEXT_LIMIT', 'The browser debugging response exceeds its size limit.');
        chunks.push(result.value);
      }
      assertNotAborted(signal);
      return Buffer.concat(chunks).toString('utf8');
    } finally { await reader.cancel().catch(() => undefined); }
  }

  private request(run: Inspection, method: string, params: Record<string, unknown> = {}, timeout: number = BROWSER_LIMITS.requestMs): Promise<unknown> {
    this.check(run);
    if (run.socket?.readyState !== WebSocket.OPEN) return Promise.reject(failed('The owned browser connection closed.'));
    const id = ++run.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { run.pending.delete(id); reject(failed(`Browser ${method} request timed out.`)); }, timeout);
      run.pending.set(id, { resolve, reject, timer });
      try { run.socket!.send(JSON.stringify({ id, method, params })); }
      catch { clearTimeout(timer); run.pending.delete(id); reject(failed('The owned browser request could not be sent.')); }
    });
  }

  private message(run: Inspection, data: unknown): void {
    if (typeof data !== 'string' || Buffer.byteLength(data) > BROWSER_LIMITS.messageBytes) {
      this.fail(run, new LittleError('CONTEXT_LIMIT', 'The browser protocol message exceeds its safe limit.'));
      return;
    }
    let parsed: Record<string, unknown> | undefined;
    try { parsed = record(JSON.parse(data)); } catch { this.fail(run, failed('The browser returned malformed protocol data.')); return; }
    if (!parsed) { this.fail(run, failed('The browser returned malformed protocol data.')); return; }
    if (typeof parsed.id === 'number') {
      const pending = run.pending.get(parsed.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      run.pending.delete(parsed.id);
      if (parsed.error) pending.reject(failed('A fixed browser inspection request was rejected.'));
      else pending.resolve(parsed.result);
      return;
    }
    const params = record(parsed.params);
    if (parsed.method === 'Fetch.requestPaused') {
      const request = record(params?.request);
      const requestId = params?.requestId;
      if (typeof requestId !== 'string' || typeof request?.url !== 'string' || params?.resourceType !== 'Document') {
        this.fail(run, failed('A browser navigation event had invalid provenance.'));
        return;
      }
      let allowed = false;
      try { allowed = appUrl(request.url).origin === run.approved.origin; } catch { /* Refuse before the document request is continued. */ }
      // Keep the gate/socket alive until the owned target is closed, even after cancellation.
      const id = ++run.nextId;
      if (!allowed) {
        run.failure ??= new LittleError('PERMISSION_DENIED', 'The local page attempted a document navigation outside the approved origin.');
        run.blockedNavigation = new Promise<void>(resolve => {
          const timer = setTimeout(() => { run.pending.delete(id); resolve(); }, 1_000);
          run.pending.set(id, { resolve: () => resolve(), reject: () => resolve(), timer });
        });
        void run.blockedNavigation.then(() => run.controller.abort(run.failure));
      }
      try {
        if (run.socket?.readyState !== WebSocket.OPEN) throw new Error('Socket closed.');
        run.socket.send(JSON.stringify({ id, method: allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest', params: { requestId, ...(allowed ? {} : { errorReason: 'BlockedByClient' }) } }));
      } catch { this.fail(run, failed('The protected browser navigation response could not be sent.')); }
    } else if (parsed.method === 'Page.frameNavigated') {
      const frame = record(params?.frame);
      if (frame?.parentId || frame?.url === 'about:blank') return;
      try {
        if (typeof frame?.url !== 'string' || appUrl(frame.url).origin !== run.approved.origin) throw new Error('Origin changed.');
        run.navigated = true;
      } catch { this.fail(run, new LittleError('PERMISSION_DENIED', 'The owned page left the approved local origin.')); }
    } else if (parsed.method === 'Page.loadEventFired' && run.navigated) run.resolveLoaded();
  }

  private async connect(run: Inspection, socketUrl: string): Promise<void> {
    this.check(run);
    const socket = new WebSocket(socketUrl);
    run.socket = socket;
    const rejectPending = (error: unknown) => {
      for (const pending of run.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
      run.pending.clear();
      run.rejectLoaded(error);
    };
    run.controller.signal.addEventListener('abort', () => rejectPending(run.failure ?? new LittleError('AGENT_CANCELLED', 'Browser inspection stopped.')), { once: true });
    socket.addEventListener('message', event => this.message(run, event.data));
    socket.addEventListener('close', () => rejectPending(run.failure ?? failed('The owned browser target closed.')));
    socket.addEventListener('error', () => this.fail(run, failed('The owned browser connection failed.')));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(failed('The owned browser connection timed out.')), BROWSER_LIMITS.requestMs);
      const abort = () => { clearTimeout(timer); reject(run.failure ?? new LittleError('AGENT_CANCELLED', 'Browser inspection stopped.')); };
      run.controller.signal.addEventListener('abort', abort, { once: true });
      socket.addEventListener('open', () => { clearTimeout(timer); run.controller.signal.removeEventListener('abort', abort); resolve(); }, { once: true });
      socket.addEventListener('close', () => { clearTimeout(timer); run.controller.signal.removeEventListener('abort', abort); reject(run.failure ?? failed('The owned browser connection closed.')); }, { once: true });
    });
    this.check(run);
  }

  private cleanup(run: Inspection): Promise<void> {
    if (!run.targetId) return Promise.resolve();
    if (run.close) return run.close;
    run.close = (async () => {
      await run.blockedNavigation;
      if (run.targetId) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), BROWSER_LIMITS.cleanupMs);
        try { await this.http(`/json/close/${run.targetId}`, 'GET', controller.signal); }
        catch { throw failed('The owned browser tab could not be confirmed closed. Close that temporary tab in Chromium before retrying.'); }
        finally { clearTimeout(timer); try { run.socket?.close(); } catch { /* Already closed. */ } }
      }
      // Closing the tab first preserves Fetch interception while teardown is in progress.
      try { run.socket?.close(); } catch { /* A failed or already-closed socket needs no further action. */ }
    })();
    return run.close;
  }

  async snapshot(url: string, signal: AbortSignal): Promise<BrowserSnapshot> {
    assertNotAborted(signal);
    if (this.disposed) throw new LittleError('AGENT_CANCELLED', 'The browser client was disposed.');
    const approved = appUrl(url);
    let resolveLoaded!: () => void;
    let rejectLoaded!: (error: unknown) => void;
    const loaded = new Promise<void>((resolve, reject) => { resolveLoaded = resolve; rejectLoaded = reject; });
    void loaded.catch(() => undefined);
    const run: Inspection = { controller: new AbortController(), approved, pending: new Map(), nextId: 0, loaded, resolveLoaded, rejectLoaded, navigated: false };
    this.active.add(run);
    const abort = () => run.controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => this.fail(run, failed('Browser inspection reached its total timeout.')), BROWSER_LIMITS.totalMs - BROWSER_LIMITS.cleanupMs);
    try {
      // Complete the small, independently bounded creation response so cancellation can learn
      // the owned target ID and close it rather than orphaning a half-created target.
      const creation = new AbortController();
      const creationTimer = setTimeout(() => creation.abort(), 2_000);
      let raw: string;
      try { raw = await this.http('/json/new?about:blank', 'PUT', creation.signal); }
      finally { clearTimeout(creationTimer); }
      let target: Record<string, unknown> | undefined;
      try { target = record(JSON.parse(raw)); } catch { throw failed('The local browser returned malformed target metadata.'); }
      if (typeof target?.id !== 'string' || !TARGET_ID.test(target.id)) throw failed('The local browser returned an invalid owned target ID.');
      run.targetId = target.id;
      if (target.type !== 'page' || target.url !== 'about:blank' || typeof target.webSocketDebuggerUrl !== 'string') throw new LittleError('PERMISSION_DENIED', 'The browser did not create a fresh blank page target.');
      let socketUrl: URL;
      try { socketUrl = new URL(target.webSocketDebuggerUrl); } catch { throw new LittleError('PERMISSION_DENIED', 'The browser returned an invalid debugger socket.'); }
      if (socketUrl.protocol !== 'ws:' || socketUrl.hostname !== this.endpoint.hostname || socketUrl.port !== this.endpoint.port || socketUrl.username || socketUrl.password || socketUrl.search || socketUrl.hash || socketUrl.pathname !== `/devtools/page/${run.targetId}`) throw new LittleError('PERMISSION_DENIED', 'The owned debugger socket must match the approved endpoint and fresh target.');
      this.check(run);
      await this.connect(run, socketUrl.href);
      await this.request(run, 'Page.enable');
      await this.request(run, 'Runtime.enable');
      await this.request(run, 'Fetch.enable', { patterns: [{ resourceType: 'Document', requestStage: 'Request' }] });
      const navigation = record(await this.request(run, 'Page.navigate', { url: approved.href }));
      this.check(run);
      if (navigation?.errorText) throw failed('The approved local page could not be loaded.');
      await run.loaded;
      this.check(run);
      const evaluation = record(await this.request(run, 'Runtime.evaluate', { expression: FIXED_DOM_EXPRESSION, returnByValue: true, awaitPromise: false, timeout: BROWSER_LIMITS.requestMs }));
      const remote = record(evaluation?.result);
      const value = record(remote?.value);
      if (evaluation?.exceptionDetails || typeof value?.url !== 'string' || typeof value.title !== 'string' || typeof value.text !== 'string' || typeof value.truncated !== 'boolean') throw failed('The local browser returned invalid DOM inspection data.');
      const finalUrl = appUrl(value.url);
      if (finalUrl.origin !== approved.origin) throw new LittleError('PERMISSION_DENIED', 'The inspected page origin differs from the approved local application.');
      const text = redactSecrets(value.text).slice(0, BROWSER_LIMITS.textChars);
      const title = redactSecrets(value.title).slice(0, 200);
      let screenshot: string | undefined;
      try {
        const captured = record(await this.request(run, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, fromSurface: true }, 3_000));
        const data = captured?.data;
        if (typeof data === 'string' && data.length <= Math.ceil(BROWSER_LIMITS.screenshotBytes / 3) * 4 && data.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
          const image = Buffer.from(data, 'base64');
          if (image.length >= 8 && image.length <= BROWSER_LIMITS.screenshotBytes && image.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) screenshot = `data:image/png;base64,${data}`;
        }
      } catch { this.check(run); /* Screenshot support is optional; rendered text remains useful. */ }
      this.check(run);
      return { url: redactSecrets(finalUrl.href), title, text, ...(screenshot ? { screenshot } : {}), truncated: value.truncated || value.text.length > BROWSER_LIMITS.textChars };
    } catch (error) {
      if (run.failure) throw run.failure;
      if (signal.aborted || run.controller.signal.aborted || this.disposed) throw new LittleError('AGENT_CANCELLED', 'Browser inspection stopped.');
      if (error instanceof LittleError) throw error;
      throw failed('The local browser inspection failed. Check the running Chromium debugging endpoint.');
    } finally {
      try { await this.cleanup(run); this.check(run); }
      finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        for (const pending of run.pending.values()) { clearTimeout(pending.timer); pending.reject(failed('The owned browser session ended.')); }
        run.pending.clear();
        this.active.delete(run);
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const run of this.active) { run.controller.abort(); void this.cleanup(run).catch(() => undefined); }
  }
}
