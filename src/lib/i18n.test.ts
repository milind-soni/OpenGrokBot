import { describe, expect, it } from "vitest";
import { DEFAULT_LOCALE, readLocale, saveLocale, translate } from "./i18n";

function memoryStorage(value?: string): Storage {
  const data = new Map<string, string>();
  if (value !== undefined) data.set("omb-locale", value);
  return {
    get length() { return data.size; },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => { data.delete(key); },
    setItem: (key, next) => { data.set(key, next); },
  };
}

describe("i18n", () => {
  it("persists supported locales and rejects stale values", () => {
    const storage = memoryStorage();
    saveLocale("zh-CN", storage);
    expect(readLocale(storage)).toBe("zh-CN");
    expect(readLocale(memoryStorage("not-a-locale"))).toBe(DEFAULT_LOCALE);
  });

  it("translates, interpolates, and falls back to English source copy", () => {
    expect(translate("zh-CN", "Nothing matches “{query}”", { query: "测试" })).toBe("没有与“测试”匹配的内容");
    expect(translate("zh-CN", "Untranslated copy")).toBe("Untranslated copy");
    expect(translate("en", "Version {version}", { version: 2 })).toBe("Version 2");
  });
});
