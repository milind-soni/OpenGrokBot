import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import {
  applyLocale,
  readLocale,
  saveLocale,
  translate,
  type LocaleId,
  type TranslationValues,
} from "./i18n";

type I18nValue = {
  locale: LocaleId;
  setLocale: (locale: LocaleId) => void;
  t: (source: string, values?: TranslationValues) => string;
};

const FALLBACK_I18N: I18nValue = {
  locale: "en",
  setLocale() {},
  t: (source, values) => translate("en", source, values),
};

const I18nContext = createContext<I18nValue>(FALLBACK_I18N);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState(readLocale);
  const value = useMemo<I18nValue>(() => ({
    locale,
    setLocale(next) {
      applyLocale(next);
      saveLocale(next);
      setLocaleState(next);
    },
    t: (source, values) => translate(locale, source, values),
  }), [locale]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  return useContext(I18nContext);
}
