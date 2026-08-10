import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.jsx';

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Console root element is missing');

const root = createRoot(rootElement);
root.render(<App />);
