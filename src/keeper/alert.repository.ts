import type { AlertRepository } from './keeper.types.js';

export class TelegramAlertRepository implements AlertRepository {
  constructor(private readonly botToken?: string, private readonly chatId?: string) {}

  async send(message: string): Promise<void> {
    if (!this.botToken || !this.chatId) return;
    const response = await fetch(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: this.chatId, text: message }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`Telegram alert failed with ${response.status}`);
  }
}
