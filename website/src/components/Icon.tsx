import type { SVGProps } from 'react';

const paths: Record<string, string> = {
  arrow: 'M5 12h14m-5-5 5 5-5 5',
  diagonal: 'M6 18 18 6M6 6h12v12',
  download: 'M12 3v12m-4-4 4 4 4-4M5 17v4h14v-4',
  sun: 'M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
  moon: 'M20 14.2A8 8 0 0 1 9.8 4 8 8 0 1 0 20 14.2Z',
  menu: 'M4 7h16M4 12h16M4 17h16',
  close: 'm6 6 12 12M6 18 18 6',
  code: 'm8 7-5 5 5 5m8-10 5 5-5 5m-3-14-2 18',
  book: 'M12 5v16M3 3h5a4 4 0 0 1 4 3 4 4 0 0 1 4-3h5v16h-5a4 4 0 0 0-4 2 4 4 0 0 0-4-2H3Z',
  check: 'm5 12 4 4L19 6',
  shield: 'm12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Zm-4 9 3 3 5-5',
  terminal: 'm5 7 5 5-5 5m8 0h6M3 3h18v18H3Z',
  layers: 'm12 3 10 6-10 6L2 9Zm-9 11 9 6 9-6M3 18l9 5 9-5',
  spark: 'm12 2 3 7 7 3-7 3-3 7-3-7-7-3 7-3Z',
  copy: 'M9 9h12v12H9ZM15 5V3H3v12h2',
  expand: 'M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5',
  folder: 'M3 5h6l2 3h10v12H3Z',
  phone: 'M7 2h10v20H7ZM10 18h4M10 5h4',
  git: 'M7 3v13a4 4 0 0 0 8 0V9m-8 1h7a4 4 0 0 0 4-4',
};

export function Icon({ name, ...props }: SVGProps<SVGSVGElement> & { name: string }) {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}><path d={paths[name] ?? paths.arrow} /></svg>;
}
