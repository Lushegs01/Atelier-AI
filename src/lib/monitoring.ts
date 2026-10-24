export function scrubMonitoringText(value: string) {
  return value
    .replace(/\/(?:api\/)?try-on\/[A-Za-z0-9_-]{20,}/g, "/try-on/[redacted]")
    .replace(/\/try\/[A-Za-z0-9_-]{20,}/g, "/try/[redacted]")
    .replace(/https?:\/\/[^\s]+(?:token|code|signature|key)=[^\s]+/gi, "[redacted-url]");
}
