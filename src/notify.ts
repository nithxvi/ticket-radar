import type { Notification, NotifyConfig, Priority } from "./types.ts";
import type { Logger } from "./log.ts";

const NTFY_PRIORITY: Record<Priority, number> = {
  min: 1,
  low: 2,
  default: 3,
  high: 4,
  urgent: 5,
};

export interface DeliveryResult {
  channel: "ntfy" | "telegram";
  ok: boolean;
  error?: string;
}

export class Notifier {
  private readonly config: NotifyConfig;
  private readonly log: Logger;

  constructor(config: NotifyConfig, log: Logger) {
    this.config = config;
    this.log = log;
  }

  get configured(): boolean {
    return Boolean(this.config.ntfy?.topic || this.config.telegram);
  }

  get channels(): string[] {
    const list: string[] = [];
    if (this.config.ntfy?.topic) list.push("ntfy");
    if (this.config.telegram) list.push("telegram");
    return list;
  }

  async send(note: Notification): Promise<DeliveryResult[]> {
    const jobs: Array<Promise<DeliveryResult>> = [];
    if (this.config.ntfy?.topic) jobs.push(this.sendNtfy(note));
    if (this.config.telegram) jobs.push(this.sendTelegram(note));
    if (jobs.length === 0) return [];
    return Promise.all(jobs);
  }

  private async sendNtfy(note: Notification): Promise<DeliveryResult> {
    const cfg = this.config.ntfy!;
    const url = cfg.server.replace(/\/+$/, "");
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(cfg.token ? { authorization: `Bearer ${cfg.token}` } : {}),
        },
        body: JSON.stringify({
          topic: cfg.topic,
          title: note.title,
          message: note.message,
          priority: NTFY_PRIORITY[note.priority],
          tags: note.tags ?? [],
          ...(note.url ? { click: note.url } : {}),
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        return { channel: "ntfy", ok: false, error: `HTTP ${response.status}` };
      }
      return { channel: "ntfy", ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.warn(`ntfy delivery failed: ${message}`);
      return { channel: "ntfy", ok: false, error: message };
    }
  }

  private async sendTelegram(note: Notification): Promise<DeliveryResult> {
    const cfg = this.config.telegram!;
    const text = `${note.title}\n\n${note.message}${note.url ? `\n\n${note.url}` : ""}`;
    try {
      const response = await fetch(`https://api.telegram.org/bot${cfg.botToken}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: cfg.chatId,
          text,
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        return { channel: "telegram", ok: false, error: `HTTP ${response.status} ${body.slice(0, 120)}` };
      }
      return { channel: "telegram", ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.warn(`telegram delivery failed: ${message}`);
      return { channel: "telegram", ok: false, error: message };
    }
  }
}
