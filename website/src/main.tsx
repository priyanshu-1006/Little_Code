import { hydrateRoot } from 'react-dom/client';
import App from './App';
import './styles.css';
import './tactile.css';

const root = document.getElementById('root');
if (!root) throw new Error('The Little Code application root is missing.');
hydrateRoot(root, <App pathname={window.location.pathname} />);
