/* Shared M3 roles for extension pages and the translation panel shadow host. */
(() => {
  const palettes = window.RTM3Palettes;
  function apply(element, color, mode) {
    const name = Object.hasOwn(palettes, color) ? color : 'purple';
    const roles = palettes[name][mode === 'light' ? 'light' : 'dark'];
    for (const [role, value] of Object.entries(roles)) {
      element.style.setProperty('--m3-' + role.replace(/[A-Z]/g, c => '-' + c.toLowerCase()), value);
    }
    return name;
  }
  function dark(theme) {
    return theme === 'dark' || (theme !== 'light' && !matchMedia('(prefers-color-scheme: light)').matches);
  }
  window.RTM3Theme = { apply, dark, palettes };
  // Extension pages start hidden until the persisted theme is available.
  if (location.protocol.endsWith('-extension:')) {
    const root = document.documentElement;
    root.style.visibility = 'hidden';
    chrome.storage.local.get('state').then(({state}) => {
      const settings = state?.settings || {};
      const mode = dark(settings.theme) ? 'dark' : 'light';
      root.dataset.theme = mode;
      apply(root, settings.themeColor, mode);
    }).catch(() => {}).finally(() => { root.style.visibility = ''; });
  }
})();
