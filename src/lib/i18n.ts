import { zhCN } from "@/locales/zh-CN";

export const LOCALES = [
  { id: "en", name: "English" },
  { id: "zh-CN", name: "简体中文" },
] as const;

export type LocaleId = (typeof LOCALES)[number]["id"];
export type TranslationValues = Record<string, string | number>;

export const DEFAULT_LOCALE: LocaleId = "en";
const STORAGE_KEY = "omb-locale";
const messages: Partial<Record<LocaleId, Record<string, string>>> = { "zh-CN": zhCN };

function isLocaleId(value: unknown): value is LocaleId {
  return LOCALES.some((locale) => locale.id === value);
}

function browserStorage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

export function readLocale(storage: Storage | undefined = browserStorage()): LocaleId {
  try {
    const stored = storage?.getItem(STORAGE_KEY);
    return isLocaleId(stored) ? stored : DEFAULT_LOCALE;
  } catch {
    return DEFAULT_LOCALE;
  }
}

export function saveLocale(locale: LocaleId, storage: Storage | undefined = browserStorage()): void {
  try {
    storage?.setItem(STORAGE_KEY, locale);
  } catch {
    // A locked-down renderer may reject storage; the in-memory choice still works.
  }
}

export function applyLocale(locale: LocaleId): void {
  if (typeof document !== "undefined") document.documentElement.lang = locale;
}

export function translate(locale: LocaleId, source: string, values: TranslationValues = {}): string {
  const template = messages[locale]?.[source] ?? source;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.hasOwn(values, name) ? String(values[name]) : match,
  );
}
