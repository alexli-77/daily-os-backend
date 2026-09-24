import type { AppConfig } from '../config/schema.js';
import { collectFeishu } from '../connectors/lark-cli.js';
import { collectGitHub } from '../connectors/github.js';
import { collectLinear } from '../connectors/linear.js';
import { collectSnapshots } from '../connectors/snapshots.js';
import { collectVault } from '../connectors/vault-gate.js';
import { readProgressLedger } from '../progress/capture.js';
import type { Evidence, EvidenceSource } from './types.js';
import { extractWeeklyPrioritiesFromFeishuDocs, extractWeeklyPrioritiesFromLocalCycle, preferLocalPriorities } from './weekly-priorities.js';
import { todoInboxEvidence } from '../todo/inbox.js';

export async function collectEvidence(config: AppConfig, date: string): Promise<Evidence> {
  const [vault, snapshots, feishu, github, linear] = await Promise.all([
    collectVault(config, date),
    collectSnapshots(config),
    collectFeishu(config, date),
    collectGitHub(config),
    collectLinear(config),
  ]);
  const sources: Record<string, EvidenceSource> = {
    ...vault,
    ...snapshots,
    ...feishu,
    github,
    linear,
    todo_inbox: config.todo_inbox.enabled
      ? {
          state: todoInboxEvidence(config).open.length ? 'available' : 'empty',
          data: todoInboxEvidence(config),
        }
      : { state: 'disabled' },
    progress_ledger: config.progress.enabled
      ? {
          state: readProgressLedger(config, date).trim() ? 'available' : 'empty',
          data: readProgressLedger(config, date),
        }
      : { state: 'disabled' },
  };

  return {
    generated_at: new Date().toISOString(),
    date,
    sources: {
      ...sources,
      weekly_priorities: preferLocalPriorities(
        extractWeeklyPrioritiesFromLocalCycle(config, date),
        extractWeeklyPrioritiesFromFeishuDocs(feishuDocsSource(sources), date),
      ),
    },
  };
}

export function feishuDocsSource(sources: Record<string, EvidenceSource>): EvidenceSource | undefined {
  const docs = Object.entries(sources).filter(([name, source]) => name === 'feishu_docs' || (name.startsWith('feishu_') && name.endsWith('_docs') && source.state === 'available'));
  if (docs.length === 0) return sources.feishu_docs;
  if (docs.length === 1) return docs[0]?.[1];
  return {
    state: 'available',
    data: Object.fromEntries(docs.map(([name, source]) => [name, source.data])),
  };
}
