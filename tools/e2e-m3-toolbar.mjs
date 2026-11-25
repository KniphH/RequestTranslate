// Run the native toolbar regression with a non-default M3 palette.
process.env.RT_POPUP_COLOR = 'blue';
await import('./e2e-popup-toolbar.mjs');
