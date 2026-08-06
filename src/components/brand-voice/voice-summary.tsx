"use client";

import { CheckCircle2 } from "lucide-react";
import { Card, CardHeader } from "@/components/ui/card";
import { summarizeBrandVoice } from "@/lib/brand-voice/summary";
import type { BrandVoiceAxes } from "@/domain";

export interface VoiceSummaryProps {
  axes: BrandVoiceAxes;
}

/**
 * The settings in plain language.
 *
 * Derived from the live form state rather than from the saved row, so it
 * describes what will be saved rather than what was.
 */
export function VoiceSummary({ axes }: VoiceSummaryProps) {
  return (
    <Card>
      <CardHeader
        title="Voice summary"
        description="The same settings in plain language, so anyone can check them."
      />
      <ul className="mt-4 space-y-2">
        {summarizeBrandVoice(axes).map((line) => (
          <li key={line} className="flex items-center gap-2 text-[13px] text-gray-700">
            <CheckCircle2 className="size-4 shrink-0 text-green-600" aria-hidden />
            {line}
          </li>
        ))}
      </ul>
    </Card>
  );
}
