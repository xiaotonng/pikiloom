import ClickSpark from '@/components/ClickSpark';
import SplashCursor from '@/components/SplashCursor';
import SafeWebGL from '@/components/SafeWebGL';
import { useIsDesktop } from '@/lib/use-device';
import Nav from '@/sections/Nav';
import Hero from '@/sections/Hero';
import Stats from '@/sections/Stats';
import UsedBy from '@/sections/UsedBy';
import Orchestrator from '@/sections/Orchestrator';
import Swarm from '@/sections/Swarm';
import InAction from '@/sections/InAction';
import Channels from '@/sections/Channels';
import Layers from '@/sections/Layers';
import Compare from '@/sections/Compare';
import BuiltWithItself from '@/sections/BuiltWithItself';
import Footer from '@/sections/Footer';

export default function App() {
  const isDesktop = useIsDesktop();

  return (
    <ClickSpark sparkColor="#7cff67" sparkSize={11} sparkRadius={24} sparkCount={9} duration={520}>
      <div id="top" className="relative min-h-screen bg-[#05060a] text-neutral-200">
        {/* WebGL fluid cursor — desktop + motion-OK only */}
        {isDesktop && (
          <SafeWebGL>
            <SplashCursor DYE_RESOLUTION={1024} SPLAT_RADIUS={0.22} />
          </SafeWebGL>
        )}
        <Nav />
        <main>
          <Hero />
          <Stats />
          <UsedBy />
          <Orchestrator />
          <Swarm />
          <InAction />
          <Channels />
          <Layers />
          <Compare />
          <BuiltWithItself />
        </main>
        <Footer />
      </div>
    </ClickSpark>
  );
}
