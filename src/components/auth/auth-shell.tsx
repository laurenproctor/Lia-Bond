import type { ReactNode } from "react";
import { Logo } from "@/components/shell/logo";

/**
 * The frame every signed-out screen shares.
 *
 * Extracted once there was a second one. Sign-in, forgot-password, and
 * reset-password are the same card on the same navy field, and three copies
 * would have drifted the moment one of them was touched.
 */
export function AuthShell({
  title,
  description,
  children,
  footer,
}: {
  title: string;
  description: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <main
      id="main"
      className="flex min-h-dvh flex-col items-center justify-center bg-navy-900 px-4 py-10"
    >
      <div className="w-full max-w-[26rem]">
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          <Logo />
          <p className="text-[13px] text-white/60">
            Reputation intelligence for restaurants
          </p>
        </div>

        <div className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
          <h1 className="text-[17px] font-semibold text-gray-950">{title}</h1>
          <p className="mt-1 mb-5 text-[13px] text-gray-500">{description}</p>
          {children}
        </div>

        {footer ? <div className="mt-4 text-center">{footer}</div> : null}
      </div>
    </main>
  );
}

/** Shared field styling, so the three forms cannot drift apart. */
export const AUTH_INPUT_CLASS =
  "h-11 w-full rounded-[10px] border border-gray-300 bg-white px-3.5 text-[14px] text-gray-950 outline-none focus-visible:border-purple-600 focus-visible:ring-2 focus-visible:ring-purple-600/20";
