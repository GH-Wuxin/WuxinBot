import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.jsx';

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Console root element is missing');

const root = import.meta.hot?.data.root || createRoot(rootElement);
if (import.meta.hot) import.meta.hot.data.root = root;
root.render(<App />);
