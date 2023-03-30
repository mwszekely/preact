import * as preact from './index.ts';
if (typeof module < 'u') module.exports = preact;
else (globalThis as any).preact = preact;
