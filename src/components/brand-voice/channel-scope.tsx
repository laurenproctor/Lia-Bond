import Link from "next/link";
import { Card, CardHeader } from "@/components/ui/card";

export interface ChannelScopeProps {
  /** Display names of the platforms this organization has connected. */
  connected: string[];
}

/**
 * Where this voice applies.
 *
 * Read from the organization's actual connections rather than typed in.
 * `CLAUDE.md` requires platform capabilities stay explicit and forbids implying
 * publishing where a source does not support it — an editable list lets
 * somebody name a platform Lia has no connector for, which is exactly the
 * implication that rule exists to prevent.
 */
export function ChannelScope({ connected }: ChannelScopeProps) {
  return (
    <Card>
      <CardHeader
        title="4. Where Lia will respond"
        description="Taken from your connected platforms. Manage these in integrations."
      />
      {connected.length > 0 ? (
        <ul className="mt-4 flex flex-wrap gap-2">
          {connected.map((channel) => (
            <li
              key={channel}
              className="rounded-lg border border-gray-200 px-2.5 py-1.5 text-[13px] text-gray-700"
            >
              {channel}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-4 text-[13px] text-gray-500">
          No platforms connected yet.{" "}
          <Link href="/integrations" className="text-purple-600 hover:underline">
            Connect one in integrations
          </Link>
          .
        </p>
      )}
    </Card>
  );
}
