import { Plug, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * The button that starts Google's OAuth flow.
 *
 * A real form posting to a route handler, not a client-side fetch. Two reasons:
 * the browser has to follow a cross-origin redirect to Google, which `fetch`
 * cannot do usefully; and a POST means the flow cannot be triggered by an
 * `<img src>` on somebody else's page, which a GET could.
 *
 * A server component — there is no state to hold. The redirect destination is
 * a fixed string here, and the route handler validates it against a closed list
 * regardless, so a tampered form field gains nothing.
 */
export function ConnectGoogleForm({
  redirectPath = "/integrations/google-business-profile/setup",
  reauthorize = false,
  label,
  size = "md",
  disabled = false,
}: {
  redirectPath?: string;
  reauthorize?: boolean;
  label?: string;
  size?: "sm" | "md" | "lg";
  disabled?: boolean;
}) {
  return (
    <form
      action="/api/integrations/google-business-profile/connect"
      method="post"
      className="contents"
    >
      <input type="hidden" name="redirectPath" value={redirectPath} />
      {reauthorize ? <input type="hidden" name="reauthorize" value="1" /> : null}
      <Button
        type="submit"
        variant={reauthorize ? "secondary" : "primary"}
        size={size}
        icon={reauthorize ? RotateCw : Plug}
        disabled={disabled}
      >
        {label ?? (reauthorize ? "Reauthorize" : "Connect Google")}
      </Button>
    </form>
  );
}
