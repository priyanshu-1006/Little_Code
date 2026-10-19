import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

export function Note({ title, children, tone = 'info' }: { title: string; children: ReactNode; tone?: 'info' | 'preview' }) {
  return <aside className={`docs-note docs-note-${tone}`}><span className="docs-note-mark" aria-hidden="true">{tone === 'preview' ? '◈' : 'i'}</span><div><strong>{title}</strong><div>{children}</div></div></aside>;
}

export function CodeBlock({ children, language = 'Prompt' }: { children: string; language?: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  async function copy() {
    try { await navigator.clipboard.writeText(children); setCopied(true); setFailed(false); }
    catch { setFailed(true); setCopied(false); }
  }
  return <div className="docs-code"><div className="docs-code-bar"><span>{language}</span><button type="button" onClick={() => { void copy(); }}>{copied ? 'Copied ✓' : 'Copy'}</button></div><pre><code>{children}</code></pre><span className="docs-sr-only" role="status">{copied ? 'Copied to clipboard.' : failed ? 'Clipboard unavailable. Select and copy the text.' : ''}</span></div>;
}

export function Screenshot({ src, alt, caption, width = 1805, height = 1022 }: { src: string; alt: string; caption: string; width?: number; height?: number }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  useEffect(() => { const node = dialog.current; const restore = () => trigger.current?.focus(); node?.addEventListener('close', restore); return () => node?.removeEventListener('close', restore); }, []);
  return <figure className="docs-figure"><button ref={trigger} type="button" className="docs-figure-button" aria-label={`Enlarge screenshot: ${alt}`} onClick={() => dialog.current?.showModal()}><img src={src} alt={alt} loading="lazy" width={width} height={height} /><span className="docs-figure-expand">View screenshot <span aria-hidden="true">↗</span></span></button><figcaption>{caption}</figcaption><dialog ref={dialog} className="docs-lightbox" aria-labelledby={titleId} onClick={event => { if (event.target === event.currentTarget) dialog.current?.close(); }}><div className="docs-lightbox-bar"><span id={titleId}>{alt}</span><button type="button" aria-label="Close screenshot" onClick={() => dialog.current?.close()}>Close <span aria-hidden="true">×</span></button></div><img src={src} alt={alt} width={width} height={height} /><p>{caption}</p></dialog></figure>;
}

export function Steps({ items }: { items: { title: string; body: ReactNode }[] }) {
  return <ol className="docs-steps">{items.map((item, index) => <li key={item.title}><span className="docs-step-number" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span><div><strong>{item.title}</strong><div>{item.body}</div></div></li>)}</ol>;
}

export function DocTable({ headers, rows }: { headers: string[]; rows: ReactNode[][] }) {
  return <div className="docs-table-wrap" tabIndex={0} role="region" aria-label={`${headers.join(' and ')} table; scroll horizontally if needed`}><table className="docs-table"><thead><tr>{headers.map(header => <th scope="col" key={header}>{header}</th>)}</tr></thead><tbody>{rows.map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j}>{cell}</td>)}</tr>)}</tbody></table></div>;
}
