/* SVG paths from RequestTranslate’s approved Design Flow prototype. See LICENSE. */
const paths = {
  check: "m4 9 3 3 7-7",
  left: "m10 4-5 5 5 5m-5-5h9",
  chevron: "m4 7 5 5 5-5",
  right: "m7 4 5 5-5 5",
  plus: "M9 3v12M3 9h12",
  copy: "M6 6h9v9H6zM12 3H3v9",
  trash: "M3 5h12m-8-2h4M5 5v10h8V5m-5 3v4m2-4v4",
  up: "m5 8 4-4 4 4M9 4v10",
  down: "m5 10 4 4 4-4M9 4v10",
  grip: "M7 4h.01M11 4h.01M7 9h.01M11 9h.01M7 14h.01M11 14h.01",
  close: "m5 5 8 8m0-8-8 8",
  moon: "M15 10a6.3 6.3 0 0 1-7-7 6.3 6.3 0 1 0 7 7Z",
  out: "M10 3h5v5m0-5-7 7m-2-7H3v12h12v-4",
  warning: "M9 3l7 12H2L9 3Zm0 4v3m0 2h.01",
  eye: "M2 9s2.6-4 7-4 7 4 7 4-2.6 4-7 4-7-4-7-4Zm7-1.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Z",
  image: "M3 3h12v12H3zM6 6h.01m-3 7 4-4 3 3 2-2 3 3",
  brand: "M4.4 6.5h7M13.7 6.5l-2.9-1.9v3.8zM13.6 11.5h-7M4.3 11.5l2.9 1.9V9.6z",
  configuration: "M3 4h12M3 9h12M3 14h12M7 2.6v2.8m4 2.2v2.8m-5 2.2v2.8",
  ocr: "M6 3H3v3m9-3h3v3M3 12v3h3m9-3v3h-3M6 7h6M6 10h6",
  variables: "M6 3c-2 0-2 1-2 3v1c0 1-.5 2-2 2 1.5 0 2 1 2 2v1c0 2 0 3 2 3m6-12c2 0 2 1 2 3v1c0 1 .5 2 2 2-1.5 0-2 1-2 2v1c0 2 0 3-2 3",
  settings: "M9 6.4a2.6 2.6 0 1 1 0 5.2 2.6 2.6 0 0 1 0-5.2ZM7.7 2.5h2.6l.4 1.8 1.6.9 1.8-.5 1.3 2.2-1.4 1.3v1.6l1.4 1.3-1.3 2.2-1.8-.5-1.6.9-.4 1.8H7.7l-.4-1.8-1.6-.9-1.8.5-1.3-2.2L4 9.8V8.2L2.6 6.9l1.3-2.2 1.8.5 1.6-.9z",
  search: "M8 13a5 5 0 1 1 0-10 5 5 0 0 1 0 10Zm3.5-1.5L15 15",
  pointer: "m4 3 10 7-5 1-2 4-3-12Z",
  translate: "M2 5h8M6 3v2m2 0c-.5 3-2.4 5.2-5 6.5M4 7c.6 1.5 2 2.8 4 4m1 4 3-7 3 7m-5.1-2h4.2",
  click: "M3 4h12v10H3zM9 7v4M7 9h4",
  panel: "M2.5 4h13v10h-13zM2.5 7h13m-5 0v7",
  history: "M3 9a6 6 0 1 1 1.8 4.3M3 5v4h4m2-3v3l2 1",
  globe: "M9 15a6 6 0 1 0 0-12 6 6 0 0 0 0 12ZM3 9h12M9 3c3 3 3 9 0 12m0-12c-3 3-3 9 0 12",
  github: "M12 .75a11.25 11.25 0 0 0-3.56 21.92c.56.1.77-.24.77-.54v-2.09c-3.13.68-3.79-1.33-3.79-1.33-.51-1.3-1.25-1.65-1.25-1.65-1.03-.7.08-.69.08-.69 1.14.08 1.73 1.17 1.73 1.17 1.01 1.72 2.66 1.22 3.31.94.1-.73.4-1.22.73-1.5-2.5-.28-5.13-1.25-5.13-5.56 0-1.23.44-2.24 1.16-3.03-.12-.29-.5-1.43.11-2.99 0 0 .95-.31 3.09 1.16a10.7 10.7 0 0 1 5.63 0c2.14-1.46 3.09-1.16 3.09-1.16.61 1.56.23 2.7.11 2.99.72.79 1.16 1.8 1.16 3.03 0 4.32-2.64 5.27-5.15 5.55.41.35.77 1.04.77 2.09v3.07c0 .3.2.65.77.54A11.25 11.25 0 0 0 12 .75Z",
};

export function uiIcon(name) {
  const viewBox = name === "github" ? "0 0 24 24" : "0 0 18 18";
  return `<svg class="icon" viewBox="${viewBox}" aria-hidden="true"><path d="${paths[name]}"/></svg>`;
}

export function fillUiIcons(root = document) {
  for (const element of root.querySelectorAll("[data-ui-icon]")) {
    const name = element.dataset.uiIcon;
    if (Object.hasOwn(paths, name)) element.innerHTML = uiIcon(name);
  }
}
