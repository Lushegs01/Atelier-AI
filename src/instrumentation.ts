import { scrubMonitoringText } from "@/lib/monitoring";
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.SENTRY_DSN) {
    const Sentry = await import("@sentry/nextjs");
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      tracesSampleRate: 0,
      beforeSend(event) {
        delete event.request;
        delete event.user;
        delete event.extra;
        delete event.contexts;
        delete event.tags;
        delete event.breadcrumbs;
        if (event.transaction) event.transaction = scrubMonitoringText(event.transaction);
        if (event.message) event.message = scrubMonitoringText(event.message);
        for (const exception of event.exception?.values || [])
          if (exception.value) exception.value = scrubMonitoringText(exception.value);
        return event;
      },
    });
  }
}
export const onRequestError = async (
  ...args: Parameters<typeof import("@sentry/nextjs").captureRequestError>
) => {
  if (!process.env.SENTRY_DSN) return;
  const Sentry = await import("@sentry/nextjs");
  Sentry.captureRequestError(...args);
};
