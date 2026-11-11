import { HERO_DEMO_DATA, RACE_DATA } from "@/lib/landing-data";
import { HeroSection } from "@/components/landing/HeroSection";
import { RuleMachineSection } from "@/components/landing/RuleMachineSection";
import { RaceSection } from "@/components/landing/RaceSection";
import { GuardianSection } from "@/components/landing/GuardianSection";
import { ProofSection } from "@/components/landing/ProofSection";
import { ClosingSection } from "@/components/landing/ClosingSection";
import { LandingNav } from "@/components/landing/LandingNav";
import { SmoothScroll } from "@/components/landing/SmoothScroll";
import { ChapterRail } from "@/components/landing/ChapterRail";
import { CenterSceneHosts } from "@/components/landing/CenterSceneHosts";
import { Footer } from "@/components/landing/Footer";

export default function LandingPage() {
  return (
    <main className="min-h-screen blueprint-grid text-bp-ink selection:bg-bp-pass selection:text-bp-canvas">
      <SmoothScroll />
      <CenterSceneHosts />
      <ChapterRail />
      <LandingNav />
      <div id="top">
        <HeroSection data={HERO_DEMO_DATA} />
      </div>
      <RuleMachineSection />
      <RaceSection data={RACE_DATA} />
      <div id="guardian">
        <GuardianSection />
      </div>
      <div id="proof">
        <ProofSection />
      </div>
      <ClosingSection />
      <Footer />
    </main>
  );
}