import { useStore } from '../store';
import { getAgentMeta } from '../utils';
import { usageGauge, usageWindowTone } from '../usage';
import { Tooltip } from './ui';
import { BrandIcon } from './BrandIcon';
import { UsageRing } from './UsageRing';
import { UsageTooltipContent } from './UsageTooltip';

export function HeaderUsage({ t }: { t: (key: string) => string }) {
  const agentStatus = useStore(s => s.agentStatus);
  const refreshAgentStatus = useStore(s => s.refreshAgentStatus);
  const entries = (agentStatus?.agents ?? []).flatMap(agent => {
    const gauge = usageGauge(agent.usage);
    return gauge ? [{ agent, gauge }] : [];
  });
  if (!entries.length) return null;
  return (
    <div className="hidden items-center gap-2 pr-1 md:flex">
      {entries.map(({ agent, gauge }) => (
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
      ))}
    </div>
  );
}
