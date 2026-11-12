import test from 'node:test';
import assert from 'node:assert/strict';
import { applyTheme, getSavedTheme, THEME_STORAGE_KEY } from '../client/src/utils/theme.js';

test('getSavedTheme defaults to light and honors persisted dark preference', () => {
  const prevStorage = globalThis.localStorage;
  try {
    const store = new Map();
    globalThis.localStorage = {
      getItem: key => (store.has(key) ? store.get(key) : null),
      setItem: (key, val) => store.set(key, String(val)),
    };

    assert.equal(getSavedTheme(), 'light');
    store.set(THEME_STORAGE_KEY, 'dark');
    assert.equal(getSavedTheme(), 'dark');
    store.set(THEME_STORAGE_KEY, 'unexpected');
    assert.equal(getSavedTheme(), 'light');
  } finally {
    globalThis.localStorage = prevStorage;
  }
});

test('applyTheme updates document dataset, colorScheme, and localStorage', () => {
  const prevStorage = globalThis.localStorage;
  const prevDocument = globalThis.document;
  try {
    const store = new Map();
    const docEl = { dataset: {}, style: {} };
    globalThis.localStorage = {
      getItem: key => (store.has(key) ? store.get(key) : null),
      setItem: (key, val) => store.set(key, String(val)),
    };
    globalThis.document = { documentElement: docEl };

    assert.equal(applyTheme('dark'), 'dark');
    assert.equal(docEl.dataset.theme, 'dark');
    assert.equal(docEl.style.colorScheme, 'dark');
    assert.equal(store.get(THEME_STORAGE_KEY), 'dark');

    assert.equal(applyTheme('light'), 'light');
    assert.equal(docEl.dataset.theme, 'light');
    assert.equal(docEl.style.colorScheme, 'light');
    assert.equal(store.get(THEME_STORAGE_KEY), 'light');
  } finally {
    globalThis.localStorage = prevStorage;
    globalThis.document = prevDocument;
  }
});

