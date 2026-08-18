/**
 * Brand voice fixture.
 *
 * Brand voice has no table yet — it arrives with the AI workflow, where the
 * settings actually drive generation. Until then the screen reads this typed
 * fixture rather than embedding sample data in JSX, so the shape is already
 * decided and moving it into the database is a repository change rather than a
 * screen rewrite.
 */

export interface VoiceAxis {
  key: string;
  leftLabel: string;
  rightLabel: string;
  /** 0 is the left-hand pole, 100 the right. */
  value: number;
}

export interface BrandVoiceProfile {
  id: string;
  name: string;
  axes: VoiceAxis[];
  approvedPhrases: string[];
  prohibitedPhrases: string[];
  channels: string[];
  summary: string[];
}

export const BRAND_VOICE_PROFILE: BrandVoiceProfile = {
  id: "maison-laurent",
  name: "Maison Laurent voice",
  axes: [
    { key: "warmth", leftLabel: "Warm", rightLabel: "Formal", value: 45 },
    { key: "detail", leftLabel: "Concise", rightLabel: "Detailed", value: 40 },
    { key: "formality", leftLabel: "Casual", rightLabel: "Professional", value: 55 },
    { key: "confidence", leftLabel: "Apologetic", rightLabel: "Confident", value: 44 },
    {
      key: "hospitality",
      leftLabel: "Hospitality-forward",
      rightLabel: "Neutral",
      value: 35,
    },
  ],
  approvedPhrases: [
    "thank you for sharing",
    "we appreciate the feedback",
    "we're here to help",
    "we look forward to welcoming you back",
  ],
  prohibitedPhrases: ["we never", "not our fault", "policy prohibits", "as per our policy"],
  channels: ["Google Business Profile", "Yelp", "Reddit", "News and media"],
  summary: [
    "Warm and polished",
    "Brief but thoughtful",
    "Avoids liability",
    "Ends with a helpful next step",
  ],
};
