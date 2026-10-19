import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { release } from '../release';
import { Icon } from './Icon';
import './site-header.css';

const productLinks = [
  { title: 'The workspace', description: 'A home for your next big idea.', href: '/#workspace', icon: 'layers' },
  { title: 'Ask, Plan, Edit & Agent', description: 'Find a flow that feels like yours.', href: '/#workflow', icon: 'spark' },
  { title: 'Framework builder', description: 'A thoughtful head start.', href: '/#build-tools', icon: 'terminal' },
  { title: 'Files & notebooks', description: 'The whole project, together.', href: '/#file-tools', icon: 'folder' },
  { title: 'Our journey', description: 'An independent idea, growing little by little.', href: '/#journey', icon: 'git' },
];

export default function SiteHeader({ dark, change, pathname = '/' }: { dark: boolean; change: () => void; pathname?: string }) {
  const [productOpen, setProductOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const header = useRef<HTMLElement>(null);
  const product = useRef<HTMLDivElement>(null);
  const productButton = useRef<HTMLButtonElement>(null);
  const productPanel = useRef<HTMLDivElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const mobilePanel = useRef<HTMLElement>(null);
  const focusProduct = useRef(false);
  const focusMobile = useRef(false);

  useEffect(() => {
    if (productOpen && focusProduct.current) { productPanel.current?.querySelector<HTMLAnchorElement>('a')?.focus(); focusProduct.current = false; }
  }, [productOpen]);
  useEffect(() => {
    if (mobileOpen && focusMobile.current) { mobilePanel.current?.querySelector<HTMLAnchorElement>('a')?.focus(); focusMobile.current = false; }
  }, [mobileOpen]);

  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return;
      if (productOpen && !product.current?.contains(event.target)) setProductOpen(false);
      if (mobileOpen && !header.current?.contains(event.target)) setMobileOpen(false);
    };
    const focus = (event: FocusEvent) => {
      if (!(event.target instanceof Node)) return;
      if (productOpen && !product.current?.contains(event.target)) setProductOpen(false);
      if (mobileOpen && !header.current?.contains(event.target)) setMobileOpen(false);
    };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (productOpen) { event.preventDefault(); setProductOpen(false); productButton.current?.focus(); }
      else if (mobileOpen) { event.preventDefault(); setMobileOpen(false); menuButton.current?.focus(); }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', focus);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('focusin', focus); document.removeEventListener('keydown', escape); };
  }, [productOpen, mobileOpen]);

  useEffect(() => {
    const media = window.matchMedia('(max-width: 1000px)');
    const close = () => {
      const active = document.activeElement;
      const wasInProduct = active instanceof Node && product.current?.contains(active);
      const wasInMobile = active instanceof Node && (mobilePanel.current?.contains(active) || menuButton.current === active);
      setProductOpen(false); setMobileOpen(false);
      if (media.matches && wasInProduct) menuButton.current?.focus();
      if (!media.matches && wasInMobile) productButton.current?.focus();
    };
    media.addEventListener('change', close);
    return () => media.removeEventListener('change', close);
  }, []);

  useEffect(() => { setProductOpen(false); setMobileOpen(false); }, [pathname]);

  function productKey(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key !== 'ArrowDown') return;
    event.preventDefault();
    if (productOpen) productPanel.current?.querySelector<HTMLAnchorElement>('a')?.focus();
    else { focusProduct.current = true; setProductOpen(true); }
  }
  function mobileKey(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key !== 'ArrowDown') return;
    event.preventDefault();
    if (mobileOpen) mobilePanel.current?.querySelector<HTMLAnchorElement>('a')?.focus();
    else { focusMobile.current = true; setMobileOpen(true); }
  }
  function closeLinks() { setProductOpen(false); setMobileOpen(false); }

  return <header className="lc-nav-root" ref={header}>
    <div className="lc-nav-frame">
      <a href="/" className="lc-nav-brand" aria-label="Little Code home" onClick={closeLinks}>
        <span className="lc-nav-logo-case"><img src="/assets/little-code-icon.png" width="34" height="34" alt="" /></span>
        <span className="lc-nav-brand-type">little<span>.</span>code<small>GOOD THINGS START LITTLE.</small></span>
      </a>
      <nav className="lc-nav-desktop" aria-label="Main navigation">
        <div className="lc-nav-product" ref={product}>
          <button type="button" ref={productButton} className={`lc-nav-link lc-nav-product-toggle${productOpen ? ' lc-nav-is-open' : ''}`} aria-label="Explore Little Code" aria-expanded={productOpen} aria-controls="lc-nav-product-panel" onClick={() => setProductOpen(value => !value)} onKeyDown={productKey}>Explore <svg className="lc-nav-chevron" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg></button>
          <div id="lc-nav-product-panel" className="lc-nav-product-panel" ref={productPanel} hidden={!productOpen}>
            <div className="lc-nav-panel-intro"><span className="lc-nav-panel-stamp"><Icon name="spark" /></span><div><span className="lc-nav-panel-eyebrow">MEET YOUR NEXT WORKSPACE</span><strong>A little more possibility.</strong></div><span className="lc-nav-release">v{release.version}</span></div>
            <div className="lc-nav-product-grid">{productLinks.map(item => <a key={item.href} className="lc-nav-product-link" href={item.href} onClick={closeLinks}><span className="lc-nav-link-tile"><Icon name={item.icon} /></span><span><strong>{item.title}</strong><small>{item.description}</small></span><Icon name="diagonal" /></a>)}</div>
            <div className="lc-nav-panel-footer"><span><i aria-hidden="true" /> YOUR IDEA, IN MOTION.</span><a href="/#download" onClick={closeLinks}>Make yourself at home <Icon name="arrow" /></a></div>
          </div>
        </div>
        <a className={`lc-nav-link${pathname.startsWith('/docs') ? ' lc-nav-current' : ''}`} aria-current={pathname === '/docs' ? 'page' : undefined} href="/docs">Documentation</a>
        <a className={`lc-nav-link${pathname === '/reviews' ? ' lc-nav-current' : ''}`} aria-current={pathname === '/reviews' ? 'page' : undefined} href="/reviews">Community<span className="lc-nav-community-dot" aria-hidden="true" /></a>
      </nav>
      <div className="lc-nav-actions">
        <a href={release.repository} className="lc-nav-icon-button lc-nav-source" aria-label="Little Code on GitHub"><Icon name="git" /></a>
        <button className="lc-nav-icon-button lc-nav-theme" type="button" aria-label={`Switch to ${dark ? 'light' : 'dark'} appearance`} aria-pressed={dark} onClick={change}><Icon name={dark ? 'sun' : 'moon'} /></button>
        <span className="lc-nav-action-divider" aria-hidden="true" />
        <a href="/#download" className="lc-nav-download lc-nav-top-download" onClick={closeLinks}>Get Little Code <Icon name="diagonal" /></a>
        <button ref={menuButton} className={`lc-nav-icon-button lc-nav-mobile-toggle${mobileOpen ? ' lc-nav-is-open' : ''}`} type="button" aria-label={mobileOpen ? 'Close navigation' : 'Open navigation'} aria-expanded={mobileOpen} aria-controls="site-navigation" onClick={() => setMobileOpen(value => !value)} onKeyDown={mobileKey}><Icon name={mobileOpen ? 'close' : 'menu'} /></button>
      </div>
    </div>
    <nav id="site-navigation" className="lc-nav-drawer" aria-label="Main navigation" ref={mobilePanel} hidden={!mobileOpen}>
      <div className="lc-nav-drawer-title"><span>FIND YOUR LITTLE THING.</span><span className="lc-nav-release">v{release.version}</span></div>
      <div className="lc-nav-mobile-products">{productLinks.map(item => <a href={item.href} key={item.href} onClick={closeLinks}><span className="lc-nav-link-tile"><Icon name={item.icon} /></span><span>{item.title}<small>{item.description}</small></span><Icon name="diagonal" /></a>)}</div>
      <div className="lc-nav-mobile-direct"><a href="/docs" aria-current={pathname === '/docs' ? 'page' : undefined} onClick={closeLinks}><Icon name="book" />Documentation<Icon name="arrow" /></a><a href="/reviews" aria-current={pathname === '/reviews' ? 'page' : undefined} onClick={closeLinks}><Icon name="spark" />Community<Icon name="arrow" /></a></div>
      <div className="lc-nav-drawer-footer"><a href={release.repository} className="lc-nav-mobile-source" aria-label="Little Code on GitHub" onClick={closeLinks}><Icon name="git" />Made in the open <Icon name="diagonal" /></a><a href="/#download" className="lc-nav-download" onClick={closeLinks}>Download for Windows <Icon name="download" /></a></div>
    </nav>
  </header>;
}
