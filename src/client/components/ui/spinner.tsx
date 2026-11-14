import { cn } from "cn";
import { Loader2Icon } from "lucide-react";

function Spinner({
  className,
  "aria-label": label = "Loading",
  "aria-hidden": hidden,
  role = "status",
  ...props
}: React.ComponentProps<"svg">) {
  return (
    <span
      role={role}
      aria-label={label}
      aria-hidden={hidden}
      className="inline-flex shrink-0"
    >
      <Loader2Icon
        data-slot="spinner"
        className={cn("size-4 animate-spin", className)}
        {...props}
        aria-hidden="true"
      />
    </span>
  );
}

export { Spinner };
