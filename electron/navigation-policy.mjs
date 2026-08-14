const LOCAL_DOCUMENT_SCHEMES = new Set(["about:", "blob:", "data:"]);

export function isAllowedSubframeNavigation(value) {
  try {
    return LOCAL_DOCUMENT_SCHEMES.has(new URL(value).protocol);
  } catch {
    return false;
  }
}

export function isTrustedExternalOpen(targetValue, referrerValue, appValue) {
  try {
    const target = new URL(targetValue);
    const referrer = new URL(referrerValue);
    const app = new URL(appValue);
    return (target.protocol === "http:" || target.protocol === "https:") && referrer.origin === app.origin;
  } catch {
    return false;
  }
}
