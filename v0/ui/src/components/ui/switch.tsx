import * as React from "react";
import * as SwitchPrimitive from "@radix-ui/react-switch";
import { cn } from "../../lib/utils";
// shadcn/ui switch: accessible Radix primitive with local Tailwind styling.
export function Switch({
  className,
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        "peer inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border border-slate-500 bg-slate-900 transition-colors data-[state=checked]:bg-cyan-700 focus-visible:outline-2 focus-visible:outline-cyan-300",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className="pointer-events-none block size-4 rounded-full bg-slate-200 transition-transform data-[state=checked]:translate-x-6 data-[state=unchecked]:translate-x-1" />
    </SwitchPrimitive.Root>
  );
}
