import "dotenv/config";

// Africa's Talking SMS sender, behind a tiny interface so tests can inject a
// mock and run fully offline. If AT credentials are absent (dev), it runs in
// "log-only" mode: it logs the outbound message instead of sending, so the whole
// webhook can be exercised locally without keys or cost.
export function createSmsClient(env = process.env) {
  const apiKey = env.AT_API_KEY;
  const username = env.AT_USERNAME;
  const from = env.AT_SHORTCODE || "";
  const live = Boolean(apiKey && username);

  return {
    live,
    async sendSms({ to, message }) {
      if (!live) {
        console.log(`[sms:log-only] -> ${to}: ${message}`);
        return { to, status: "logged", live: false };
      }
      const body = new URLSearchParams({ username, to, message });
      if (from) body.set("from", from);
      const res = await fetch("https://api.africastalking.com/version1/messaging", {
        method: "POST",
        headers: {
          apiKey,
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`AT send failed ${res.status}: ${text.slice(0, 160)}`);
      }
      return { to, status: "sent", live: true, response: await res.json().catch(() => null) };
    },
  };
}

// Test double: records everything "sent" for assertions.
export function createMockSmsClient() {
  const sent = [];
  return {
    live: false,
    sent,
    async sendSms({ to, message }) {
      sent.push({ to, message });
      return { to, status: "mock" };
    },
  };
}
