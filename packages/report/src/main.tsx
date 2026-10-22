import '@fontsource-variable/manrope';
import '@fontsource-variable/jetbrains-mono';
import './theme/tokens.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app';
import { watchGlassBudget } from './glass/budget';

const ROOT_ID = 'root';

const container = document.getElementById(ROOT_ID);
if (container === null) {
  throw new Error(`The report page has no #${ROOT_ID} element to render into`);
}
watchGlassBudget(document.body);
createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
