import { uiIcon } from './ui-icons.js';

export const narrowOptions = matchMedia('(max-width: 640px)');
const listPositions = new WeakMap();

export function openOptionsDetail(panel) {
  if (narrowOptions.matches && !panel.classList.contains('show-detail')) {
    listPositions.set(panel, window.scrollY);
  }
  panel.classList.add('show-detail');
  if (narrowOptions.matches) {
    const detail = panel.querySelector('.editor:not([hidden]), .settings-detail');
    if (detail) {
      window.scrollTo(0, 0);
      detail.querySelector('[data-list-back]')?.focus({preventScroll: true});
    }
  }
}

export function bindOptionsNavigation() {
  const app = document.querySelector('.app');
  const header = app.querySelector('.top');
  const nav = header.querySelector('nav');
  const desktopActions = header.querySelector('.end');
  const settingsActions = app.querySelector('.settings-page-actions');
  const ocrSwitch = app.querySelector('.ocr-switch');
  const ocrFooter = app.querySelector('.ocr-list-foot');
  const ocrTools = app.querySelector('.ocr-list-tools');
  const actions = [...desktopActions.children];
  const layout = () => {
    const narrow = narrowOptions.matches;
    const focused = document.activeElement;
    if (narrow) app.append(nav);
    else header.insertBefore(nav, desktopActions);
    nav.classList.toggle('bottom-nav', narrow);
    header.hidden = narrow;
    (narrow ? settingsActions : desktopActions).append(...actions);
    (narrow ? ocrTools : ocrFooter).prepend(ocrSwitch);
    if (focused?.getClientRects().length && focused !== document.activeElement) focused.focus({preventScroll: true});
  };
  layout();
  narrowOptions.addEventListener('change', layout);
  document.addEventListener('focusin', event => {
    if (narrowOptions.matches) return;
    const detail = event.target.closest('.editor, .settings-detail');
    detail?.closest('.tabpanel').classList.add('show-detail');
  });
  document.addEventListener('click', event => {
    const back = event.target.closest('[data-list-back]');
    if (!back) return;
    const panel = back.closest('.tabpanel');
    panel.classList.remove('show-detail');
    if (narrowOptions.matches) window.scrollTo(0, listPositions.get(panel) || 0);
    const previous = panel.querySelector('[data-last-result]') ||
      panel.querySelector('.cfg-item.is-active, .settings-entry[aria-pressed=true]') || panel.querySelector('.list-title button');
    previous?.focus({preventScroll: true});
  });
}

const categoryIcons = {
  selection: 'pointer', translation: 'translate', trigger: 'click', panel: 'panel',
  backup: 'brand', history: 'history'
};

// Alias keys augment the visible, localized setting names and control labels.
const aliases = {
  's-trigger': 'opt_ui_alias_selection', 'btn-hotkey-open': 'opt_ui_alias_shortcuts',
  's-theme': 'opt_ui_alias_theme', 's-lang': 'opt_ui_alias_language',
  's-panelcss': 'opt_ui_alias_css', 'btn-import': 'opt_ui_alias_import',
  'btn-clear-history': 'opt_ui_alias_history'
};

const normalize = text => String(text ?? '').normalize('NFKC').toLowerCase().trim();
const caption = element => element?.textContent.trim() || '';

export function bindSettingsDirectory(panel, text, helpText, onSelect) {
  const doc = panel.ownerDocument;
  const query = panel.querySelector('#settings-search');
  const byCategory = panel.querySelector('#settings-categories');
  const resultList = panel.querySelector('#settings-results');
  const empty = panel.querySelector('#settings-empty');
  const clear = panel.querySelector('#settings-search-clear');
  const categories = [...panel.querySelectorAll('.set-group')].map(detail => ({
    detail,
    key: detail.dataset.category,
    title: caption(detail.querySelector('.set-group-t')),
    summary: text('opt_ui_summary_' + detail.dataset.category)
  }));
  let active = categories[0];
  let highlighted, highlightTimer;

  function select(category, target, button) {
    if (active !== category) {
      const temporary = active.detail.querySelector('[data-search-revealed]');
      if (temporary) {
        temporary.removeAttribute('data-search-revealed');
        temporary.hidden = temporary.querySelector('select').disabled;
      }
    }
    active = category;
    for (const item of categories) {
      item.detail.hidden = item !== category;
      item.button.setAttribute('aria-pressed', String(item === category));
    }
    if (button) {
      panel.querySelector('[data-last-result]')?.removeAttribute('data-last-result');
      button.setAttribute('data-last-result', '');
      openOptionsDetail(panel);
    }
    onSelect(category.key);
    if (!button) return;
    if (!target) {
      if (narrowOptions.matches) category.detail.querySelector('[data-list-back]').focus({preventScroll: true});
      return;
    }
    if (target.hidden) {
      if (target.id !== 'row-slotinsert') return;
      target.setAttribute('data-search-revealed', '');
      target.hidden = false;
      target.querySelector('select').disabled = true;
    }
    highlighted?.classList.remove('search-hit');
    clearTimeout(highlightTimer);
    highlighted = target;
    target.classList.add('search-hit');
    target.tabIndex = -1;
    target.focus({preventScroll: true});
    target.scrollIntoView({block: 'center'});
    highlightTimer = setTimeout(() => target.classList.remove('search-hit'), 2000);
  }

  function entry(category, title, subtitle, target) {
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'settings-entry';
    button.dataset.category = category.key;
    button.innerHTML = uiIcon(categoryIcons[category.key]) + '<span class="settings-entry-copy"><span></span><small></small></span>' + uiIcon('right');
    const copy = button.querySelector('.settings-entry-copy');
    copy.firstElementChild.textContent = title;
    copy.lastElementChild.textContent = subtitle;
    copy.lastElementChild.title = subtitle;
    button.addEventListener('click', () => select(category, target, button));
    return button;
  }

  function renderSearch() {
    const terms = normalize(query.value).split(/[\s/]+/).filter(Boolean);
    const matches = [];
    clear.hidden = !query.value;
    byCategory.hidden = Boolean(terms.length);
    if (terms.length) {
      function match(category, title, related, target) {
        const name = normalize(title);
        const own = name + ' ' + normalize(related);
        if (!terms.some(term => own.includes(term))) return;
        const searchText = own + (target ? ' ' + normalize(category.title) : '');
        if (!terms.every(term => searchText.includes(term))) return;
        const rank = name === terms.join(' ') ? 0 : terms.every(term => name.includes(term)) ? 1 : 2;
        matches.push({category, title, target, rank});
      }
      for (const category of categories) {
        match(category, category.title, category.summary);
        for (const target of category.detail.querySelectorAll('.setting')) {
          const label = target.querySelector(':scope > .card-label > :is(label,span), :scope > label:not(.switch)');
          const description = helpText(label?.parentElement.dataset.settingHelp);
          const controls = [...target.querySelectorAll('input[id], select[id], textarea[id], button[data-i18n]')];
          const titles = [...target.querySelectorAll('label, button[data-i18n], option, .help-details summary, .help-details p')].map(caption);
          const title = caption(label) || titles.find(Boolean);
          const keywords = controls.map(control => aliases[control.id] ? text(aliases[control.id]) : '');
          if (title) match(category, title, titles.concat(keywords, description).join(' '), target);
          for (const control of controls) {
            const own = caption(control.closest('label')) || (control.matches('button') ? caption(control) : '');
            if (own && own !== title) match(category, own, '', control.closest('label') || target);
          }
        }
      }
    }
    empty.hidden = !terms.length || Boolean(matches.length);
    resultList.hidden = !matches.length;
    resultList.replaceChildren(...matches.sort((a, b) => a.rank - b.rank).map(({category, title, target}) =>
      entry(category, title, target ? category.title : category.summary, target)
    ));
  }

  for (const category of categories) {
    category.button = entry(category, category.title, category.summary);
    byCategory.append(category.button);
  }
  select(active);
  query.addEventListener('input', () => {
    renderSearch();
    if (narrowOptions.matches) window.scrollTo(0, 0);
    else panel.querySelector('.settings-index-list').scrollTop = 0;
  });
  const reset = () => {
    query.value = '';
    renderSearch();
    query.focus();
  };
  clear.addEventListener('click', reset);
  query.addEventListener('keydown', event => {
    if (event.isComposing) return;
    if (event.key === 'Escape' && query.value) {
      event.preventDefault();
      reset();
    } else if (event.key === 'Enter' && !resultList.hidden) {
      event.preventDefault();
      resultList.firstElementChild?.click();
    }
  });
}
