// CityThrive fork: placeholder for all-sites pages that are still being built.
import { Link } from "@tanstack/react-router";
import { PageHeader } from "@/client/components/PageHeader";
import { Button } from "@/client/components/ui/button";
import { fleetSiteTableLabel } from "@/client/navigation/fleetNav";

export function ComingSoonPage({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="px-4 py-4 md:px-6 md:py-6">
      <div className="mx-auto flex max-w-3xl flex-col gap-5">
        <PageHeader title={title} description={description} />
        <div className="rounded-xl border border-dashed border-border p-6 text-sm text-muted-foreground">
          This page is being built and will appear here soon. Meanwhile, the
          site table has every site with Search Console, GA4 and audit data,
          plus a CSV export of the whole fleet.
          <div className="mt-4">
            <Button nativeButton={false} render={<Link to="/overview" />}>
              Open {fleetSiteTableLabel.toLowerCase()}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
