import { InlineConfirm } from "@/client/components/InlineConfirm";
import { Button } from "@/client/components/ui/button";

export function GoogleConnectedState({
  property,
  detail,
  email,
  onChange,
  onDisconnect,
  onReconnect,
  disconnecting,
  canManage,
  canManageAccounts,
  disabled,
}: {
  property: string;
  detail?: string | null;
  email?: string | null;
  onChange: () => void;
  onDisconnect: () => void;
  onReconnect: () => void;
  disconnecting: boolean;
  canManage: boolean;
  canManageAccounts: boolean;
  disabled: boolean;
}) {
  return (
    <div className="space-y-4">
      <div className="min-w-0">
        <p className="break-words text-sm font-semibold">
          {property || detail}
        </p>
        {detail ? (
          <p className="mt-1 text-xs text-muted-foreground">
            ID {detail.replace(/^properties\//, "")}
          </p>
        ) : null}
        {email ? (
          <p className="mt-1 break-all text-sm text-muted-foreground">
            {email}
          </p>
        ) : null}
      </div>
      {canManage || canManageAccounts ? (
        <fieldset
          disabled={disconnecting || disabled}
          className="flex flex-wrap items-center gap-1"
        >
          <Button variant="outline" size="sm" onClick={onChange}>
            {canManage
              ? "Change property or account"
              : "Manage Google accounts"}
          </Button>
          {canManage ? (
            <Button variant="outline" size="sm" onClick={onReconnect}>
              Reconnect Google account
            </Button>
          ) : null}
          {canManage ? (
            <InlineConfirm
              label="Disconnect project"
              triggerLabel={
                disconnecting ? "Disconnecting…" : "Disconnect project"
              }
              confirmLabel="Disconnect"
              pending={disconnecting}
              onConfirm={onDisconnect}
            />
          ) : null}
        </fieldset>
      ) : null}
    </div>
  );
}
