import { Hero } from "@/components/nextlayer/Hero";
import { PlainSection } from "@/components/nextlayer/PlainSection";
import { HowSection } from "@/components/nextlayer/HowSection";
import { RulesSection } from "@/components/nextlayer/RuleMachine";
import { RaceSection } from "@/components/nextlayer/RaceSection";
import { GuardianSection } from "@/components/nextlayer/GuardianSection";
import { ProofSection } from "@/components/nextlayer/ProofSection";
import { EnvelopeSection } from "@/components/nextlayer/EnvelopeSection";
import { LimitsSection } from "@/components/nextlayer/LimitsSection";
import { Closing } from "@/components/nextlayer/Closing";
import { Smooth } from "@/components/nextlayer/Smooth";
import { Journey } from "@/components/nextlayer/Journey";
import { Motion } from "@/components/nextlayer/Motion";
import { SiteHeader } from "@/components/nextlayer/SiteHeader";

export default function LandingPage() {
  return (
    <div className="nl" id="top">
      <a className="nl-skip" href="#main">Skip to content</a>
      <SiteHeader />
      <div className="nl-journey" data-nl-journey>
        <Hero />
      </div>
      <main id="main" tabIndex={-1}>
        <PlainSection />
        <HowSection />
        <RulesSection />
        <RaceSection />
        <GuardianSection />
        <ProofSection />
        <EnvelopeSection />
        <LimitsSection />
      </main>
      <Closing />
      <Motion />
      <Journey />
      <Smooth />
    </div>
  );
}
