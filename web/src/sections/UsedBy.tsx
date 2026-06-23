import type { ComponentType, ReactNode } from 'react';
import { ByteDance, Tencent, Alibaba, Meta, Google, Moonshot, Minimax, Stepfun } from '@lobehub/icons';
import { LogoLoop, type LogoItem } from '@/components/LogoLoop';

type ColoredIcon = ComponentType<{ size?: number }>;
function brand(Icon: unknown, size = 22): ReactNode {
  const I = Icon as ColoredIcon & { Color?: ColoredIcon; Mono?: ColoredIcon };
  const Comp = I.Color ?? I.Mono ?? I;
  return <Comp size={size} />;
}

function Co({ logo, name }: { logo: ReactNode; name: string }) {
  return (
    <span className="flex items-center gap-2.5 whitespace-nowrap text-lg font-medium tracking-tight text-neutral-300">
      <span className="grid h-6 w-6 place-items-center">{logo}</span>
      {name}
    </span>
  );
}

const COMPANIES: LogoItem[] = [
  { node: <Co logo={brand(ByteDance)} name="ByteDance" />, title: 'ByteDance' },
  { node: <Co logo={brand(Tencent)} name="Tencent" />, title: 'Tencent' },
  { node: <Co logo={brand(Alibaba)} name="Alibaba" />, title: 'Alibaba' },
  { node: <Co logo={brand(Meta)} name="Meta" />, title: 'Meta' },
  { node: <Co logo={brand(Google)} name="Google" />, title: 'Google' },
  { node: <Co logo={brand(Moonshot)} name="Moonshot AI" />, title: 'Moonshot AI' },
  { node: <Co logo={brand(Minimax)} name="MiniMax" />, title: 'MiniMax' },
  { node: <Co logo={brand(Stepfun)} name="StepFun" />, title: 'StepFun' },
];

export default function UsedBy() {
  return (
    <section className="relative mx-auto max-w-6xl px-6 py-16">
      <p className="text-center text-xs uppercase tracking-[0.22em] text-neutral-600">
        Engineers from these teams build with pikiloom
      </p>
      <div className="mt-9">
        <LogoLoop
          logos={COMPANIES}
          speed={28}
          logoHeight={28}
          gap={64}
          pauseOnHover
          scaleOnHover
          fadeOut
          fadeOutColor="#05060a"
          ariaLabel="Companies whose engineers use pikiloom"
        />
      </div>
    </section>
  );
}
