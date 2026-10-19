import { useEffect, useState } from 'react';
import { release } from '../release';
import { verifiedGithubAsset, verifiedLocalAsset } from '../downloadProtocol';
import { Icon } from './Icon';

type DownloadState = { ready: boolean; url: string; label: string; message: string; source: 'github' | 'local' | 'pending' };
const fallback: DownloadState = { ready: false, url: release.releasePage, label: 'View GitHub releases', message: 'Checking the published release for the matching Windows installer…', source: 'pending' };

export function Download() {
  const [state, setState] = useState(fallback);
  const [attempt, setAttempt] = useState(0);
  const [copied, setCopied] = useState(false);
  const [platform, setPlatform] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12_000);
    let mounted = true;
    setState(fallback);
    if (/Mac|Linux|Android|iPhone|iPad/i.test(navigator.userAgent)) setPlatform('This preview is for Windows x64. macOS, Linux and mobile installers are not available yet.');
    const read = async (url: string) => {
      const response = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
      if (!response.ok) return null;
      if (Number(response.headers.get('content-length')) > 2_000_000) throw new Error('Release metadata too large');
      const text = await response.text();
      if (text.length > 2_000_000) throw new Error('Release metadata too large');
      return JSON.parse(text) as unknown;
    };
    void (async () => {
      try {
        if (['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname)) {
          try {
            const local = verifiedLocalAsset(await read('/api/release'), release);
            if (local) { if (mounted) setState({ ready: true, url: local, label: 'Download for Windows', source: 'local', message: 'Local installer verified against the pinned file size and SHA-256.' }); clearTimeout(timer); return; }
          } catch { if (controller.signal.aborted) throw new Error('Release lookup cancelled'); }
        }
        const url = verifiedGithubAsset(await read(release.releaseApi), release);
        if (mounted) setState(url ? { ready: true, url, label: 'Download for Windows', source: 'github', message: 'GitHub release matched: exact filename, size and SHA-256 digest.' } : { ...fallback, message: 'The matching public setup is not confirmed yet. Check GitHub releases for availability.' });
      } catch { if (mounted) setState({ ...fallback, message: 'Could not confirm release availability. GitHub releases and the verification guide are still available.' }); }
      finally { clearTimeout(timer); }
    })();
    return () => { mounted = false; controller.abort(); clearTimeout(timer); };
  }, [attempt]);

  async function copyChecksum() {
    try { await navigator.clipboard.writeText(release.sha256); setCopied(true); }
    catch { setCopied(false); }
  }

  return <section className="download-section section" id="download" aria-labelledby="download-title">
    <div className="section-kicker"><span>06 / YOUR NEXT WORKSPACE</span><span>Windows preview · {release.version}</span></div>
    <div className="download-layout"><div className="download-copy"><h2 id="download-title">Big things<br />start <em>little.</em></h2><p>Make room for your next idea. Get the standalone workspace, bring your model, and start building.</p><a className="text-link" href="/docs/installation">Read the installation guide <Icon name="arrow" /></a></div>
      <div className="download-card"><div className="download-card-heading"><span className="windows-mark" aria-hidden="true"><i /><i /><i /><i /></span><div><h3>Little Code for Windows</h3><p>Windows 10 / 11 · x64 · per-user setup</p></div><span className="version-chip">v{release.version}</span></div>
        <dl className="download-specs"><div><dt>Version</dt><dd>{release.version} preview</dd></div><div><dt>Download size</dt><dd>{(release.bytes / 1_000_000).toFixed(1)} MB</dd></div><div><dt>Package</dt><dd>Standalone .exe</dd></div><div><dt>Publisher signature</dt><dd>Unsigned preview</dd></div></dl>
        <a id="download-setup" className={`button button-accent download-primary ${state.ready ? 'is-ready' : ''}`} href={state.url} download={state.source === 'local' ? release.fileName : undefined}><Icon name={state.ready ? 'download' : 'diagonal'} />{state.label}<Icon name="arrow" /></a>
        <p className="download-state" role="status"><span className={state.ready ? 'status-dot' : 'status-dot pending'} />{state.message}</p>
        <button type="button" className="quiet-button" onClick={() => setAttempt(value => value + 1)}>Check availability again <span aria-hidden="true">↻</span></button>
        {platform && <p className="download-platform-note">{platform}</p>}
        <details className="checksum"><summary>Verify your download <Icon name="shield" /></summary><div><p>Compare the downloaded file’s SHA-256 with this exact value. A checksum identifies the build; it does not replace a publisher signature.</p><code>{release.sha256}</code><button className="quiet-button" type="button" onClick={copyChecksum}><Icon name="copy" />{copied ? 'Checksum copied' : 'Copy checksum'}</button><a href="/docs/installation#verify-your-download">How to check it on Windows <Icon name="diagonal" /></a></div></details>
        <p className="download-footnote">macOS, Linux and ARM packages are not published. SDKs and model downloads are separate. Review the <a href="/docs/installation">preview installation notes</a> before installing.</p>
      </div></div>
    <div className="download-path" aria-label="Getting started"><a href="#download"><span>01</span> Download the setup</a><a href="/docs/installation#verify-your-download"><span>02</span> Verify the checksum</a><a href="/docs/installation"><span>03</span> Install on Windows</a><a href="/docs/first-conversation"><span>04</span> Choose your model</a></div>
  </section>;
}
