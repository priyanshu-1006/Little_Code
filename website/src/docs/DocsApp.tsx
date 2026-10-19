import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { release } from '../release';
import { docsArticles, docsGroups } from './content';
import type { DocsArticle } from './content';
import './docs.css';

function Icon({ name, className = '' }: { name: 'search' | 'arrow' | 'menu' | 'sun' | 'moon' | 'book' | 'close' | 'download' | 'chevron'; className?: string }) {
  const paths: Record<string, ReactNode> = {
    search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></>,
    arrow: <><path d="M5 12h14M13 6l6 6-6 6" /></>,
    menu: <><path d="M4 6h16M4 12h16M4 18h16" /></>,
    sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" /></>,
    moon: <path d="M20 13.5A8.5 8.5 0 0 1 10.5 4 8.5 8.5 0 1 0 20 13.5Z" />,
    book: <><path d="M12 5c-3-2-6-2-9-1v15c3-1 6-1 9 1 3-2 6-2 9-1V4c-3-1-6-1-9 1Zm0 0v15" /><path d="M6 8h3M6 12h3m6-4h3m-3 4h3" /></>,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    download: <><path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5" /></>,
    chevron: <path d="m9 5 7 7-7 7" />,
  };
  return <svg className={`docs-icon ${className}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

function ArticleCard({ article, index }: { article: DocsArticle; index: number }) {
  return <a className="docs-guide-card" href={`/docs/${article.slug}`}><span className="docs-card-number">{String(index + 1).padStart(2, '0')}</span><div><h3>{article.title}</h3><p>{article.description}</p><span className="docs-card-time">{article.minutes} min read</span></div><Icon name="arrow" /></a>;
}

export default function DocsApp({ slug }: { slug?: string }) {
  const article = docsArticles.find(item => item.slug === slug);
  const [query, setQuery] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [activeSection, setActiveSection] = useState('');
  const [dark, setDark] = useState(false);
  const search = useRef<HTMLInputElement>(null);
  const normalized = query.toLocaleLowerCase().trim();
  const matches = useMemo(() => {
    if (!normalized) return [];
    const words = normalized.split(/\s+/);
    return docsArticles.filter(item => { const haystack = `${item.title} ${item.description} ${item.keywords} ${item.sections.map(section => `${section.title} ${section.summary}`).join(' ')}`.toLocaleLowerCase(); return words.every(word => haystack.includes(word)); });
  }, [normalized]);
  useEffect(() => {
    try { setDark(localStorage.getItem('little-showcase-theme') === 'dark'); }
    catch { setDark(document.documentElement.dataset.theme === 'dark'); }
    document.title = `${article?.title ?? (slug ? 'Guide not found' : 'Documentation')} — Little Code`;
    setMenuOpen(false); setQuery(''); setActiveSection(article?.sections[0]?.id ?? '');
  }, [article, slug]);
  useEffect(() => {
    function keyboard(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); search.current?.focus(); }
      if (event.key === 'Escape') { setMenuOpen(false); setQuery(''); }
    }
    const syncTheme = () => setDark(document.documentElement.dataset.theme === 'dark');
    window.addEventListener('keydown', keyboard);
    window.addEventListener('little-theme-change', syncTheme);
    return () => { window.removeEventListener('keydown', keyboard); window.removeEventListener('little-theme-change', syncTheme); };
  }, []);
  useEffect(() => {
    if (!article || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(entries => { const visible = entries.filter(entry => entry.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top); if (visible[0]) setActiveSection(visible[0].target.id); }, { rootMargin: '-110px 0px -55% 0px' });
    article.sections.forEach(section => { const heading = document.getElementById(section.id); if (heading) observer.observe(heading); });
    return () => observer.disconnect();
  }, [article]);
  const articleIndex = article ? docsArticles.indexOf(article) : -1;
  const previous = docsArticles[articleIndex - 1];
  const next = docsArticles[articleIndex + 1];
  function toggleTheme() { const value = document.documentElement.dataset.theme !== 'dark'; document.documentElement.dataset.theme = value ? 'dark' : 'light'; setDark(value); try { localStorage.setItem('little-showcase-theme', value ? 'dark' : 'light'); } catch { /* Appearance remains usable without persistent storage. */ } window.dispatchEvent(new Event('little-theme-change')); }
  return <div className="docs-site">
    <a className="docs-skip" href="#docs-content">Skip to content</a>
    <header className="docs-header"><div className="docs-header-inner">
      <a className="docs-brand" href="/" aria-label="Little Code home"><img src="/assets/little-code-icon.png" width="36" height="36" alt="" /><span>Little Code<span className="docs-brand-divider" aria-hidden="true">/</span><span className="docs-brand-guide">Field guide</span></span></a>
      <div className="docs-search"><Icon name="search" /><label className="docs-sr-only" htmlFor="docs-search-input">Search documentation</label><input id="docs-search-input" ref={search} value={query} placeholder="Find something…" autoComplete="off" aria-controls={normalized ? 'docs-search-results' : undefined} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && matches[0]) window.location.assign(`/docs/${matches[0].slug}`); }} /><kbd>Ctrl K</kbd>{normalized && <div id="docs-search-results" className="docs-search-results"><p className="docs-search-count" role="status">{matches.length ? `${matches.length} ${matches.length === 1 ? 'guide' : 'guides'} found` : 'No guides found. Try a different term.'}</p>{matches.map(item => <a key={item.slug} href={`/docs/${item.slug}`}><strong>{item.title}</strong><span>{item.description}</span><Icon name="arrow" /></a>)}</div>}</div>
      <nav className="docs-header-nav" aria-label="Documentation header"><a href="/">Product <span aria-hidden="true">↗</span></a><button className="docs-theme" type="button" onClick={toggleTheme} aria-label={dark ? 'Switch to light appearance' : 'Switch to dark appearance'}><Icon name={dark ? 'sun' : 'moon'} /></button><a className="docs-download" href="/#download"><Icon name="download" /><span>Download</span></a></nav>
    </div></header>
    <div className="docs-mobile-bar"><button type="button" aria-expanded={menuOpen} aria-controls="docs-sidebar" onClick={() => setMenuOpen(!menuOpen)}><Icon name={menuOpen ? 'close' : 'menu'} />Browse documentation</button><span>v{release.version}</span></div>
    <div className={`docs-layout ${!article ? 'docs-layout-overview' : ''}`}>
      <aside className={`docs-sidebar ${menuOpen ? 'docs-sidebar-open' : ''}`} id="docs-sidebar"><nav aria-label="Documentation chapters"><a className={`docs-overview-link ${!slug ? 'docs-nav-active' : ''}`} aria-current={!slug ? 'page' : undefined} href="/docs"><Icon name="book" />Documentation</a>{docsGroups.map(group => <div className="docs-nav-group" key={group}><p>{group}</p>{docsArticles.filter(item => item.group === group).map(item => <a key={item.slug} href={`/docs/${item.slug}`} aria-current={item.slug === slug ? 'page' : undefined} className={item.slug === slug ? 'docs-nav-active' : ''}>{item.title}<Icon name="chevron" /></a>)}</div>)}</nav><div className="docs-version-note"><span className="docs-version-dot" />{release.version} · Windows preview<p>Small steps.<br />Real understanding.</p><a href={`${release.repository}/issues`} target="_blank" rel="noreferrer">Need a hand? <span aria-hidden="true">↗</span></a></div></aside>
      <main className="docs-content" id="docs-content" tabIndex={-1}>
        {!slug ? <>
          <div className="docs-intro"><span className="docs-eyebrow"><span />THE LITTLE CODE FIELD GUIDE</span><h1>Make yourself<br /><em>at home.</em></h1><p>Everything you need to go from your first install to a project you understand. A clear path, one step at a time.</p><div className="docs-intro-actions"><a className="docs-primary-link" href="/docs/getting-started">Start with your first project <Icon name="arrow" /></a><span>11 guides · built around the app</span></div><div className="docs-intro-orbit" aria-hidden="true"><Icon name="book" /><span>READ. TRY. BUILD.</span></div></div>
          <div className="docs-quick-links"><a href="/docs/installation"><span className="docs-quick-icon"><Icon name="download" /></span><div><strong>A fresh start</strong><span>Download, verify & install</span></div><Icon name="arrow" /></a><a href="/docs/first-conversation"><span className="docs-quick-icon docs-quick-purple">✧</span><div><strong>Meet your model</strong><span>Groq Cloud or local Ollama</span></div><Icon name="arrow" /></a><a href="/docs/troubleshooting"><span className="docs-quick-icon docs-quick-orange">?</span><div><strong>Find your way back</strong><span>Errors, retries & saved chats</span></div><Icon name="arrow" /></a></div>
          {docsGroups.map((group, groupIndex) => <section className="docs-chapter" key={group}><div className="docs-chapter-heading"><span>CHAPTER {String(groupIndex + 1).padStart(2, '0')}</span><h2>{group}</h2><span className="docs-chapter-line" /></div><div className="docs-guide-grid">{docsArticles.filter(item => item.group === group).map(item => <ArticleCard article={item} index={docsArticles.indexOf(item)} key={item.slug} />)}</div></section>)}
          <div className="docs-bottom-note"><Icon name="book" /><div><strong>Written for the product that exists.</strong><p>These guides distinguish implemented workflows from release acceptance, and real native screenshots from illustrations. The current preview is Windows x64.</p></div></div>
        </> : article ? <article>
          <div className="docs-breadcrumb"><a href="/docs">Documentation</a><span aria-hidden="true">/</span><span>{article.group}</span></div>
          <header className="docs-article-header"><div className="docs-article-meta"><span>GUIDE {String(articleIndex + 1).padStart(2, '0')}</span><span>{article.minutes} MIN READ</span><span>v{release.version}</span></div><h1>{article.title}</h1><p>{article.description}</p></header>
          <details className="docs-mobile-toc"><summary>On this page</summary><nav aria-label="On this page, mobile">{article.sections.map(section => <a key={section.id} href={`#${section.id}`}>{section.title}</a>)}</nav></details>
          <div className="docs-article-body">{article.sections.map(section => <section className="docs-section" key={section.id}><h2 id={section.id}><a href={`#${section.id}`}>{section.title}<span aria-hidden="true">#</span></a></h2>{section.content}</section>)}</div>
          <div className="docs-article-source"><span>Grounded in the Little Code product source.</span><a href={article.source} target="_blank" rel="noreferrer">View source guide <span aria-hidden="true">↗</span></a></div>
          <nav className="docs-pagination" aria-label="Previous and next guide">{previous ? <a href={`/docs/${previous.slug}`}><span>← Previous guide</span><strong>{previous.title}</strong></a> : <a href="/docs"><span>← Back to</span><strong>All documentation</strong></a>}{next ? <a href={`/docs/${next.slug}`}><span>Next guide →</span><strong>{next.title}</strong></a> : <a href="/#download"><span>Ready for the next step? ↗</span><strong>Get Little Code</strong></a>}</nav>
        </article> : <div className="docs-not-found"><span className="docs-eyebrow">A SMALL DETOUR</span><h1>This guide isn’t here.</h1><p>Choose a chapter from the sidebar, search above, or head back to the field guide.</p><a className="docs-primary-link" href="/docs">All documentation <Icon name="arrow" /></a></div>}
        <footer className="docs-footer"><span>Little Code. Your idea, in motion.</span><a href={release.repository} target="_blank" rel="noreferrer">Built in the open <span aria-hidden="true">↗</span></a></footer>
      </main>
      {article && <aside className="docs-toc"><span>ON THIS PAGE</span><nav aria-label="On this page">{article.sections.map(section => <a key={section.id} href={`#${section.id}`} className={activeSection === section.id ? 'docs-toc-active' : ''} aria-current={activeSection === section.id ? 'location' : undefined}>{section.title}</a>)}</nav><div className="docs-toc-help"><p>Something unclear?</p><a href={`${release.repository}/issues`} target="_blank" rel="noreferrer">Help improve this guide <span aria-hidden="true">↗</span></a></div></aside>}
    </div>
  </div>;
}
