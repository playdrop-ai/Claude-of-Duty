import en from './en.json';
import fr from './fr.json';
import de from './de.json';
import es from './es.json';
import ptBR from './pt-BR.json';
import id from './id.json';
import ja from './ja.json';
import ko from './ko.json';
import zhHans from './zh-Hans.json';
import zhHant from './zh-Hant.json';

export const messages = { en, fr, de, es, 'pt-BR': ptBR, id, ja, ko, 'zh-Hans': zhHans, 'zh-Hant': zhHant };
export const locales = Object.keys(messages);
// Standalone play has one documented source language: English. Hosted play sets
// the SDK's supported locale before importing any game systems or creating UI.
let locale = 'en';
export const getLocale = () => locale;
export function setLocale(value) {
  if (!Object.hasOwn(messages, value)) throw new Error(`Unsupported PlayDrop host locale: ${value}`);
  locale = value;
  document.documentElement.lang = locale;
  document.documentElement.classList.toggle('cjk', /^(ja|ko|zh-)/.test(locale));
  document.title = t('title');
}
export function t(key, values) {
  const message = messages[locale][key];
  if (typeof message !== 'string') throw new Error(`Missing ${locale} translation: ${key}`);
  if (!message.includes('{')) return message;
  return message.replace(/\{(\w+)\}/g, (_, name) => {
    if (!values || !Object.hasOwn(values, name)) throw new Error(`Missing ${key} parameter: ${name}`);
    return String(values[name]);
  });
}
