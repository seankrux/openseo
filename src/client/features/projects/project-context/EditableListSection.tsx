import { useRef, useState, type ReactNode } from "react";
import { Pencil, Plus } from "lucide-react";
import { Button } from "@/client/components/ui/button";
import { EmptyState } from "@/client/components/EmptyState";
import { InlineConfirm } from "@/client/components/InlineConfirm";
import { SectionHeader } from "@/client/components/PageHeader";
import { RowActions, listClass } from "./shared";

/** The same add, edit, and remove interaction for both context lists. */
export function EditableListSection<T>({
  title,
  hint,
  addLabel,
  emptyTitle,
  emptyDescription,
  items,
  getId,
  getLabel,
  renderItem,
  renderForm,
  onRemove,
  pending,
}: {
  title: string;
  hint: string;
  addLabel: string;
  emptyTitle: string;
  emptyDescription: string;
  items: T[];
  getId: (item: T) => string;
  getLabel: (item: T) => string;
  renderItem: (item: T) => ReactNode;
  renderForm: (item: T | undefined, close: () => void) => ReactNode;
  onRemove: (item: T) => void;
  pending: boolean;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const triggerIdRef = useRef<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const open = (id: string, trigger: HTMLButtonElement) => {
    triggerIdRef.current = id;
    triggerRef.current = trigger;
    setEditing(id);
  };
  const close = () => {
    setEditing(null);
    // Edit triggers remount when their row's editor closes.
    requestAnimationFrame(() => triggerRef.current?.focus());
  };

  return (
    <section className="space-y-3">
      <SectionHeader
        title={title}
        hint={hint}
        action={
          <Button
            ref={(trigger) => {
              if (triggerIdRef.current === "add") triggerRef.current = trigger;
            }}
            variant="ghost"
            size="xs"
            disabled={pending}
            onClick={(event) => open("add", event.currentTarget)}
          >
            <Plus className="size-3.5" />
            {addLabel}
          </Button>
        }
      />
      {editing === "add" ? (
        <div className={listClass}>{renderForm(undefined, close)}</div>
      ) : null}
      {items.length === 0 ? (
        editing === "add" ? null : (
          <EmptyState
            size="sm"
            icon={null}
            title={emptyTitle}
            description={emptyDescription}
          />
        )
      ) : (
        <ul className={listClass}>
          {items.map((item) => {
            const id = getId(item);
            return editing === id ? (
              <li key={id}>{renderForm(item, close)}</li>
            ) : (
              <li
                key={id}
                className="flex items-start justify-between gap-3 p-3"
              >
                {renderItem(item)}
                <RowActions>
                  <Button
                    ref={(trigger) => {
                      if (triggerIdRef.current === id)
                        triggerRef.current = trigger;
                    }}
                    variant="ghost"
                    size="icon-xs"
                    disabled={pending}
                    aria-label={`Edit ${getLabel(item)}`}
                    onClick={(event) => open(id, event.currentTarget)}
                  >
                    <Pencil className="size-3.5" />
                  </Button>
                  <InlineConfirm
                    label={`Remove ${getLabel(item)}`}
                    pending={pending}
                    onConfirm={() => onRemove(item)}
                  />
                </RowActions>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
