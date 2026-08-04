import type { Metadata } from "next";
import { BookOpen, LifeBuoy, ShieldAlert } from "lucide-react";
import { PageBody } from "@/components/shell/app-shell";
import { HelpRequestForm } from "@/components/support/help-request-form";
import { Card, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { requireSession } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Help" };

export default async function HelpPage() {
  const session = await requireSession();

  return (
    <PageBody>
      <PageHeader
        title="Help"
        description="Send the Lia team a question, a bug report, or a request. Replies come straight back to you by email."
      />

      <div className="grid gap-4 xl:grid-cols-12">
        <div className="xl:col-span-8">
          <Card>
            <CardHeader
              title="Contact support"
              description="Pick the topic that fits best — it decides who picks the request up."
            />
            <div className="mt-5">
              <HelpRequestForm defaultEmail={session.email} />
            </div>
          </Card>
        </div>

        <div className="flex flex-col gap-4 xl:col-span-4">
          <Card>
            <CardHeader title="Before you write" />
            <ul className="mt-4 flex flex-col gap-4">
              <Tip
                icon={ShieldAlert}
                title="Something urgent on a live review?"
                body="Raise it as an escalation instead. Escalations reach the people on call for that location; this form reaches the Lia team."
              />
              <Tip
                icon={BookOpen}
                title="Reporting a bug"
                body="Name the location or mention you were looking at, and what you expected to see. That is usually enough for us to reproduce it on the first try."
              />
              <Tip
                icon={LifeBuoy}
                title="Copying a colleague"
                body="Anyone you copy receives the original request and every reply in the thread."
              />
            </ul>
          </Card>

          <Card>
            <CardHeader title="What we can see" />
            <p className="mt-3 text-[13px] leading-6 text-gray-500">
              Your request is sent with your name, your role, and which
              organization you were working in — nothing else from the app.
              Review text, customer names, and your connected accounts are never
              attached.
            </p>
          </Card>
        </div>
      </div>
    </PageBody>
  );
}

function Tip({
  icon: Icon,
  title,
  body,
}: {
  icon: typeof LifeBuoy;
  title: string;
  body: string;
}) {
  return (
    <li className="flex gap-3">
      <span className="mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-lg bg-purple-50 text-purple-600">
        <Icon className="size-4" aria-hidden />
      </span>
      <div className="min-w-0">
        <p className="text-[13px] font-medium text-gray-950">{title}</p>
        <p className="mt-0.5 text-[13px] leading-5.5 text-gray-500">{body}</p>
      </div>
    </li>
  );
}
