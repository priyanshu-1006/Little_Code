import { createRoot } from 'react-dom/client';
import { App } from './view';
import type { ClientMessage } from './protocol';
import './tokens.css';
import './webview.css';

declare function acquireVsCodeApi(): { postMessage(message: ClientMessage): void };
const host = acquireVsCodeApi();
const root = document.getElementById('root');
if (!root) throw new Error('Little Agent mount point is missing.');
createRoot(root).render(<App send={message => host.postMessage(message)} />);
