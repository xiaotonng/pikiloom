import { useStore } from '../store';
import { getAgentMeta } from '../utils';
import { usageGauge, usageWindowTone } from '../usage';
import { Tooltip } from './ui';
import { BrandIcon } from './BrandIcon';
import { UsageRing } from './UsageRing';
import { UsageTooltipContent } from './UsageTooltip';
import { HeaderAccountMenu } from './HeaderAccountMenu';

// Agents whose local accounts are token-switched (kept in sync with the backend).
const ACCOUNT_AGENTS = new Set(['claude']);

export function HeaderUsage({ t }: { t: (key: string) => string }) {
  const agentStatus = useStore(s => s.agentStatus);
  const refreshAgentStatus = useStore(s => s.refreshAgentStatus);
  const agents = agentStatus?.agents ?? [];

  const nodes = agents.flatMap(agent => {
    const gauge = usageGauge(agent.usage);
    // claude / codex: render the account switcher (it manages its own visibility + usage).
    if (agent.installed && ACCOUNT_AGENTS.has(agent.agent)) {
      return [<HeaderAccountMenu key={agent.agent} agent={agent.agent} nativeGauge={gauge} nativeUsage={agent.usage} t={t} />];
    }
    // other agents: the original read-only usage ring + tooltip.
    if (!gauge) return [];
    return [(
      <Tooltip
        key={agent.agent}
        content={(
          <UsageTooltipContent
            usage={agent.usage}
            t={t}
            title={`${getAgentMeta(agent.agent).label} · ${t('usage.accountQuota')}`}
          />
        )}
        onShow={() => void refreshAgentStatus()}
        className="cursor-default items-center gap-1"
      >
        <BrandIcon brand={agent.agent} size={12} />
        <UsageRing
          percent={gauge.primary.usedPercent ?? 0}
          tone={usageWindowTone(gauge.primary)}
          trackTone={gauge.secondaryTone ?? undefined}
          alert={gauge.secondaryAlert}
          size={13}
        />
      </Tooltip>
    )];
  });

  if (!nodes.length) return null;
  return <div className="hidden items-center gap-2 pr-1 md:flex">{nodes}</div>;
}
