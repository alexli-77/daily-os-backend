import type { AppConfig } from '../config/schema.js';

export type NotificationSource = keyof AppConfig['notifications']['sources'];
export type NotificationChannel = 'feishu';

/**
 * LEO-339 — may the service push `source` to `channel` without being asked?
 *
 * Every level has to say yes: the master switch, the source, the channel on
 * that source, and the channel's transport. The transport check keeps
 * `output.feishu.enabled: false` meaning what it always meant — no Feishu
 * output at all — so a config written before this existed behaves the same.
 */
export function notificationAllowed(config: AppConfig, source: NotificationSource, channel: NotificationChannel): boolean {
  const notifications = config.notifications;
  if (!notifications.enabled) return false;
  const row = notifications.sources[source];
  if (!row.enabled || !row[channel]) return false;
  return config.output.feishu.enabled;
}
